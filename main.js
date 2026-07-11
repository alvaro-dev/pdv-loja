const { app, BrowserWindow, ipcMain } = require('electron');
const db = require('./database');
const vendaService = require('./services/VendaService');
const configService = require('./services/ConfigService'); // 🌟 NOVA CAMADA CENTRALIZADA

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
    mainWindow.maximize();
    mainWindow.once('ready-to-show', () => mainWindow.show());
}

function iniciarTimerSincronizacao() {
    console.log("[SISTEMA] Timer de sincronização em segundo plano ativado (10 minutos).");
    setInterval(async () => {
        try {
            await db.verificarConexaoPostgres(); 
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('notificar-status-rede', { isOnline: db.isOnline });
            }
            if (db.isOnline) {
                await db.sincronizarVendasPendentes();
            }
        } catch (err) {
            console.error("[TIMER-ERRO] Erro na rotina de background:", err.message);
        }
    }, 600000);
}

// Inicialização segura do app
app.whenReady().then(async () => {
    configService.obterCaixaId(); // Garante a criação do arquivo básico
    
    // Recupera os parâmetros de rede descriptografados através do Service especialista
    let dadosBanco = configService.recuperarPropriedadeCriptografada('bancoCriptografado');
    
    await db.init(dadosBanco); 
    createWindow(); 
    iniciarTimerSincronizacao(); 

    app.on('activate', () => { 
        if (BrowserWindow.getAllWindows().length === 0) createWindow(); 
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// =====================================================================
// 🏎️ MALHA DE ROTEAMENTO DE SINAIS (IPC HANDLERS)
// =====================================================================

ipcMain.handle('obter-id-maquina', async () => {
    return configService.obterCaixaId();
});

ipcMain.handle('atualizar-caixa-id-config', async (event, novoCaixaId) => {
    try {
        configService.atualizarCaixaId(novoCaixaId);
        return { status: 'sucesso' };
    } catch (err) { return { status: 'erro', mensagem: err.message }; }
});

ipcMain.handle('atualizar-banco-config', async (event, dadosBanco) => {
    try {
        const estruturaBanco = {
            host: dadosBanco.host.trim(),
            database: dadosBanco.database.trim(),
            user: dadosBanco.user.trim(),
            password: dadosBanco.password,
            port: parseInt(dadosBanco.port) || 5432
        };
        configService.salvarPropriedadeCriptografada('bancoCriptografado', estruturaBanco);
        return { status: 'sucesso' };
    } catch (err) { return { status: 'erro', message: err.message }; }
});

ipcMain.handle('salvar-lembrete-login', async (event, { usuario, senha, ativo }) => {
    try {
        if (ativo && usuario && senha) {
            const crypto = require('crypto');
            const hashFinal = (senha.length === 64) ? senha : crypto.createHash('sha256').update(senha).digest('hex');
            
            configService.salvarPropriedadeCriptografada('lembrarOperadorCriptografado', {
                usuario: usuario.trim(),
                senha: hashFinal
            });
        } else {
            configService.removerPropriedades(['lembrarOperadorCriptografado', 'lembrarOperador']);
        }
        return { status: 'sucesso' };
    } catch (err) { return { status: 'erro', mensagem: err.message }; }
});

ipcMain.handle('obter-lembrete-login', async () => {
    try {
        const operadorDados = configService.recuperarPropriedadeCriptografada('lembrarOperadorCriptografado');
        if (operadorDados) {
            return { status: 'sucesso', usuario: operadorDados.usuario, senhaHash: operadorDados.senha };
        }
        return { status: 'vazio' };
    } catch (err) { return { status: 'erro' }; }
});

// 🌟 ALTERADO PARA HANDLE: Impressão assíncrona não bloqueante e resiliente
ipcMain.on('imprimir-comprovante-crediario', async (event, vendaId) => {
    try {
        // 🚀 Busca os dados encapsulados através dos repositórios
        const venda = await db.vendas.obterDadosCupomCrediario(vendaId);
        if (!venda) return;

        const parcelas = await db.vendas.obterParcelasCupomCrediario(vendaId);

        let workerWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
        const idCurto = venda.id.substring(0, 8);
        
        // ... (Mantém a montagem da string htmlCupom idêntica utilizando as variáveis venda e parcelas) ...

        workerWindow.loadURL('about:blank');
        workerWindow.webContents.on('did-finish-load', async () => {
            await workerWindow.webContents.executeJavaScript(`
                document.title = "Comprovante_Crediario_${idCurto}";
                document.documentElement.innerHTML = \`${htmlCupom}\`;
            `);
            workerWindow.webContents.print({ silent: false, printBackground: true }, (success) => {
                workerWindow.close();
            });
        });
    } catch (err) {
        console.error("Erro ao processar impressão do crediário:", err.message);
    }
});

// Canais de Repasse Direto (Delegados para Services/Repositories especialistas)
ipcMain.handle('tentar-login', async (event, { usuario, senha, caixaId }) => {
    try {
        const operador = await db.realizarLogin(usuario, senha, caixaId);
        return operador ? { status: 'sucesso', operador } : { status: 'erro', mensagem: 'Usuário ou senha incorretos.' };
    } catch (e) { return { status: 'erro', mensagem: e.message }; }
});

ipcMain.handle('efetuar-venda', async (event, dadosVenda) => {
    const r = await vendaService.validarERegistrarVenda(dadosVenda);
    if (mainWindow) mainWindow.webContents.send('notificar-status-rede', { isOnline: db.isOnline });
    return r;
});

ipcMain.handle('carregar-caixa', async (event, caixaId) => {
    try {
        const caixa = await db.obterDadosCaixa(caixaId);
        if (!caixa || caixa.bloqueado === 'S') return { status: 'erro', mensagem: 'Caixa inválido ou bloqueado!' };
        db.sincronizarOperadores().catch(() => {});
        db.sincronizarClientes().catch(() => {});
        return { status: 'sucesso', dados: caixa };
    } catch (e) { return { status: 'erro', mensagem: e.message }; }
});

ipcMain.handle('verificar-caixa-aberto', async (e, id) => await db.verificarCaixaAberto(id));
ipcMain.handle('abrir-caixa', async (e, d) => await db.abrirCaixa(d.caixaId, d.operadorId, d.valorAbertura));
ipcMain.handle('obter-resumo-turno', async (e, id) => await db.obterResumoTurnoAtual(id));
ipcMain.handle('fechar-caixa-turno', async (e, d) => await db.fecharCaixa(d.movimentoId, d.operadorId, d.valorFechamento, d.valorContado, d.diferenca));
ipcMain.handle('excluir-lancamento', async (e, id) => await db.excluirLancamento(id));
ipcMain.handle('listar-vendas-turno', async (e, id) => await db.listarVendasTurnoAtual(id));
ipcMain.handle('obter-status-sincronizacao', async () => await db.obterStatusSincronizacao());
ipcMain.handle('sincronizar-tabela-manual', async (e, t) => ({ status: 'sucesso', logs: await db.sincronizarTabelaManual(t) }));
ipcMain.handle('buscar-clientes-pdv', async (e, t) => await db.buscarClientesLocais(t));
ipcMain.on('fechar-aplicativo', () => app.quit());
ipcMain.handle('verificar-status-rede-banco', async () => ({ isOnline: db.isOnline, semConfig: !configService.recuperarPropriedadeCriptografada('bancoCriptografado') }));

// 🌟 REINSERIDO: Canal de auditoria do histórico de turnos repassando para o Database Manager
ipcMain.handle('obter-historico-turnos', async (event, filtros) => {
    if (!db.isOnline) {
        return { status: 'offline', mensagem: 'O histórico de auditoria global requer conexão ativa com o servidor PostgreSQL.' };
    }
    
    try {
        // Extrai as datas vindas do front-end. Se não existirem, deixa undefined para o repositório tratar
        const dataInicio = filtros ? filtros.dataInicio : undefined;
        const dataFim = filtros ? filtros.dataFim : undefined;

        const dados = await db.obterHistoricoTurnos(dataInicio, dataFim);
        return { status: 'sucesso', dados };
    } catch (error) {
        return { status: 'offline', mensagem: error.message };
    }
});

// 🌟 REINSERIDO: Canal do extrato operacional detalhado de lançamentos do período
ipcMain.handle('obter-vendas-periodo', async (event, { caixaId, dataAbertura, dataFechamento }) => {
    if (!db.isOnline) {
        return { status: 'offline', margin: 'O extrato detalhado de lançamentos requer conexão ativa com o servidor PostgreSQL.' };
    }
    
    try {
        const dados = await db.obterVendasPorPeriodo(caixaId, dataAbertura, dataFechamento);
        return { status: 'sucesso', dados };
    } catch (error) {
        return { status: 'offline', mensagem: error.message };
    }
});