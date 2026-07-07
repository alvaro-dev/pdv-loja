const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs'); // Módulo para ler/escrever arquivos
const db = require('./database');

let mainWindow;

// Caminho onde o arquivo de configuração vai morar no Windows:
// C:\Users\SEU_USUARIO\AppData\Roaming\pdv-loja\config.json
const caminhoConfig = path.join(app.getPath('userData'), 'config.json');

// Função para obter o ID do caixa configurado nesta máquina
// Função focada apenas em ler o ID do caixa configurado no config.json
function obterCaixaIdDaMaquina() {
    try {
        if (fs.existsSync(caminhoConfig)) {
            const arquivo = fs.readFileSync(caminhoConfig, 'utf8');
            const config = JSON.parse(arquivo);
            return config.caixaId || null; // 🌟 Retorna null se não estiver configurado
        } else {
            // Cria o arquivo básico vazio na primeira execução, sem inventar um ID
            fs.writeFileSync(caminhoConfig, JSON.stringify({ caixaId: "" }, null, 2));
            return null;
        }
    } catch (err) {
        console.error("Erro ao ler config.json:", err);
        return null;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,  // Largura padrão caso seja desmaximizada[cite: 4, 10]
        height: 700, // Altura padrão caso seja desmaximizada[cite: 4, 10]
        show: false, // 🌟 DICA DE OURO: Inicia oculta para não dar aquele "estalo" visual ao maximizar
        webPreferences: {
            nodeIntegration: true, //[cite: 4, 10]
            contextIsolation: false //[cite: 4, 10]
        }
    });

    mainWindow.loadFile('index.html'); //[cite: 4, 10]
    
    // 🌟 FORÇA A TELA A INICIAR MAXIMIZADA
    mainWindow.maximize();
    
    // Mostra a janela apenas quando ela já estiver maximizada e pronta
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
    
    // Opcional: Abre o console de desenvolvedor automaticamente para ajudar nos testes
    // mainWindow.webContents.openDevTools();
}

// Função para disparar a sincronização a cada 10 minutos
function iniciarTimerSincronizacao() {
    console.log("[SISTEMA] Timer de sincronização em segundo plano ativado (Intervalo: 10 minutos).");
    
    setInterval(async () => {
        try {
            // 1. Verifica se a rede com o Ubuntu/Postgres está ativa
            await db.verificarConexaoPostgres(); 
            
            // 2. Se estiver online, executa a limpeza de pendências
            if (db.isOnline) {
                await db.sincronizarVendasPendentes();
            }
        } catch (err) {
            console.error("[TIMER-ERRO] Erro na rotina de background:", err.message);
        }
    }, 600000); // 600.000 ms = Exatamente 10 minutos
}

// Inicializa o app e os bancos de dados
app.whenReady().then(async () => {
    // Garante que a estrutura básica do arquivo exista
    obterCaixaIdDaMaquina(); 
    
    let dadosBanco = null;
    try {
        const arquivoConfig = JSON.parse(fs.readFileSync(caminhoConfig, 'utf8'));
        // Se existir a propriedade banco no JSON, captura ela
        if (arquivoConfig && arquivoConfig.banco) {
            dadosBanco = arquivoConfig.banco;
        }
    } catch (e) {
        console.error("Não foi possível ler os parâmetros do banco no config.json");
    }
    
    // 🌟 Passa os dados encontrados (ou null caso não existam) para o banco de dados
    await db.init(dadosBanco); 
    
    // Dispara a sincronização de operadores logo após iniciar o banco
    db.sincronizarOperadores() //
        .then(res => console.log(`[SYNC] Operadores prontos:`, res)) //
        .catch(err => console.error(`[SYNC] Falha ao sincronizar operadores no início:`, err)); //

    createWindow(); //
    iniciarTimerSincronizacao(); //

    app.on('activate', () => { //
        if (BrowserWindow.getAllWindows().length === 0) createWindow(); //
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

/**
 * Canal de Comunicação IPC (Inter-Process Communication)
 * Escuta os pedidos de venda vindos da tela do caixa (index.html)
 * Agora recebendo todos os parâmetros de negócio exigidos pelas tabelas
 */

 ipcMain.handle('tentar-login', async (event, { usuario, senha, caixaId }) => {
     try {
        // O operador só passa a existir a partir desta linha:
        const operador = await db.realizarLogin(usuario, senha, caixaId);
        
        if (!operador) {
            return { status: 'erro', mensagem: 'Usuário ou senha incorretos.' };
        }

        return { status: 'sucesso', operador };

    } catch (error) {
        // 🚨 MUITA ATENÇÃO AQUI: 
        // No catch, a variável "operador" NÃO existe. Temos que usar apenas "error.message"
        console.error("Bloqueio de segurança no login:", error.message);
        return { status: 'erro', mensagem: error.message };
    }
});

ipcMain.handle('efetuar-venda', async (event, dadosVenda) => {
    try {
        // 🛠️ AJUSTADO: Extrai também bandeira e parcelas vindas do objeto enviado pelo front-end
        const { 
            caixaId, 
            operadorId, 
            total, 
            formaPagamento, 
            origem, 
            descricaoMovimento,
            bandeira,
            parcelas 
        } = dadosVenda;
        
        // 🛠️ AJUSTADO: Passa as novas variáveis para o método do database.js
        const resultado = await db.registrarVenda(
            caixaId, 
            operadorId, 
            total, 
            formaPagamento, 
            origem, 
            descricaoMovimento,
            bandeira,
            parcelas
        );
        
        return resultado;
    } catch (error) {
        console.error("Erro processando venda no processo Main:", error);
        return { status: 'erro', mensagem: error.message };
    }
});

// Canal para carregar os dados do caixa na inicialização
ipcMain.handle('carregar-caixa', async (event, caixaId) => {
    try {
        const caixa = await db.obterDadosCaixa(caixaId);
        
        if (!caixa || caixa.bloqueado === 'S') {
            // Envia um comando para exibir o alerta antes de fechar
            return { status: 'erro', mensagem: 'Caixa não cadastrado para este ponto de venda ou está bloqueado!' };
        }
        
        return { status: 'sucesso', dados: caixa };
    } catch (error) {
        return { status: 'erro', mensagem: error.message };
    }
});

// Canal para fechar o aplicativo forçadamente
ipcMain.on('fechar-aplicativo', () => {
    app.quit();
});

/**
 * Canal para a tela pedir o ID do caixa desta máquina
 */
ipcMain.handle('obter-id-maquina', async () => {
    // CORREÇÃO: Mudado de 'obtenerCaixaIdDaMaquina' para 'obterCaixaIdDaMaquina'
    return obterCaixaIdDaMaquina(); 
});

// Canal para verificar se o caixa já está aberto
ipcMain.handle('verificar-caixa-aberto', async (event, caixaId) => {
    try {
        return await db.verificarCaixaAberto(caixaId);
    } catch (error) {
        console.error("Erro ao verificar caixa aberto:", error);
        return false; // Em caso de erro, assume falso para forçar a rotina de segurança
    }
});

// Canal para realizar a abertura do caixa
ipcMain.handle('abrir-caixa', async (event, dados) => {
    try {
        const { caixaId, operadorId, valorAbertura } = dados;
        return await db.abrirCaixa(caixaId, operadorId, valorAbertura);
    } catch (error) {
        console.error("Erro ao abrir caixa no Main:", error);
        return { status: 'erro', mensagem: error.message };
    }
});

ipcMain.handle('obter-resumo-turno', async (event, caixaId) => {
    return await db.obterResumoTurnoAtual(caixaId);
});

ipcMain.handle('fechar-caixa-turno', async (event, dados) => {
    // 🛠️ AJUSTADO: Agora recebe valorContado e diferenca do front-end
    const { movimentoId, operadorId, valorFechamento, valorContado, diferenca } = dados;
    return await db.fecharCaixa(movimentoId, operadorId, valorFechamento, valorContado, diferenca);
});

ipcMain.handle('excluir-lancamento', async (event, vendaId) => {
    try {
        return await db.excluirLancamento(vendaId);
    } catch (error) {
        return { status: 'erro', mensagem: error.message };
    }
});

ipcMain.handle('listar-vendas-turno', async (event, caixaId) => {
    return await db.listarVendasTurnoAtual(caixaId);
});

ipcMain.handle('obter-historico-turnos', async (event, filtros) => {
    if (!db.isOnline) {
        return { status: 'offline', mensagem: 'O histórico de auditoria global requer conexão ativa com o servidor PostgreSQL.' };
    }
    
    try {
        // Extrai as datas vindas da tela. Se não existirem, deixa undefined para o banco tratar
        const dataInicio = filtros ? filtros.dataInicio : undefined;
        const dataFim = filtros ? filtros.dataFim : undefined;

        const dados = await db.obterHistoricoTurnos(dataInicio, dataFim);
        return { status: 'sucesso', dados };
    } catch (error) {
        return { status: 'offline', mensagem: error.message };
    }
});

ipcMain.handle('obter-vendas-periodo', async (event, { caixaId, dataAbertura, dataFechamento }) => {
    if (!db.isOnline) {
        return { status: 'offline', mensagem: 'O extrato detalhado de lançamentos requer conexão ativa com o servidor PostgreSQL.' };
    }
    
    try {
        const dados = await db.obterVendasPorPeriodo(caixaId, dataAbertura, dataFechamento);
        return { status: 'sucesso', dados };
    } catch (error) {
        return { status: 'offline', mensagem: error.message };
    }
});

// 💾 Canal para salvar as credenciais salvas no config.json do Windows
// 💾 Canal Corrigido: Trata o Hash no processo principal (Main) antes de salvar no config.json
ipcMain.handle('salvar-lembrete-login', async (event, { usuario, senha, ativo }) => {
    try {
        let config = {};
        if (fs.existsSync(caminhoConfig)) {
            config = JSON.parse(fs.readFileSync(caminhoConfig, 'utf8'));
        }
        
        if (ativo) {
            // Se a senha já vier como hash de 64 caracteres (login automático), mantém. 
            // Caso contrário, gera o hash SHA-256 usando o método do database.js
            const hashFinal = (senha && senha.length === 64) ? senha : db.gerarHashSenha(senha);
            config.lembrarOperador = { usuario, senha: honestyHash(hashFinal) };
        } else {
            delete config.lembrarOperador;
        }
        
        fs.writeFileSync(caminhoConfig, JSON.stringify(config, null, 2));
        return { status: 'sucesso' };
    } catch (err) {
        return { status: 'erro', mensagem: err.message };
    }
});

// 📖 Canal para recuperar o login automático salvo
ipcMain.handle('obter-lembrete-login', async () => {
    try {
        if (fs.existsSync(caminhoConfig)) {
            const config = JSON.parse(fs.readFileSync(caminhoConfig, 'utf8'));
            if (config.lembrarOperador) {
                return { 
                    status: 'sucesso', 
                    usuario: config.lembrarOperador.usuario, 
                    senhaHash: desofuscarSenha(config.lembrarOperador.senha) 
                };
            }
        }
        return { status: 'vazio' };
    } catch (err) {
        return { status: 'erro' };
    }
});

// Funções auxiliares simples para não salvar o hash puramente exposto no arquivo texto
function honestyHash(text) { return Buffer.from(text).toString('base64'); }
function desofuscarSenha(text) { return Buffer.from(text, 'base64').toString('utf8'); }

// Canal para obter as estatísticas das tabelas locais
ipcMain.handle('obter-status-sincronizacao', async () => {
    try {
        return await db.obterStatusSincronizacao();
    } catch (error) {
        return { status: 'erro', mensagem: error.message };
    }
});

// Canal para disparar a sincronização de uma tabela específica por demanda
ipcMain.handle('sincronizar-tabela-manual', async (event, tipo) => {
    try {
        const logs = await db.sincronizarTabelaManual(tipo);
        return { status: 'sucesso', logs };
    } catch (error) {
        return { status: 'erro', mensagem: error.message };
    }
});

// 🌟 NOVO: Canal para gravar o caixaId editado manualmente pela tela de erro
ipcMain.handle('atualizar-caixa-id-config', async (event, novoCaixaId) => {
    try {
        let config = {};
        if (fs.existsSync(caminhoConfig)) {
            config = JSON.parse(fs.readFileSync(caminhoConfig, 'utf8'));
        }
        
        // Atualiza a propriedade do terminal com o UUID colhido
        config.caixaId = novoCaixaId.trim();
        
        fs.writeFileSync(caminhoConfig, JSON.stringify(config, null, 2));
        return { status: 'sucesso' };
    } catch (err) {
        console.error("Erro ao salvar caixaId manualmente:", err);
        return { status: 'erro', mensagem: err.message };
    }
});

// 🌟 NOVO: Canal para gravar os parâmetros do Postgres recebidos do front-end
ipcMain.handle('atualizar-banco-config', async (event, dadosBanco) => {
    try {
        let config = {};
        if (fs.existsSync(caminhoConfig)) {
            config = JSON.parse(fs.readFileSync(caminhoConfig, 'utf8'));
        }
        
        // Injeta ou atualiza a propriedade do banco de dados de forma higienizada
        config.banco = {
            host: dadosBanco.host.trim(),
            database: dadosBanco.database.trim(),
            user: dadosBanco.user.trim(),
            password: dadosBanco.password,
            port: parseInt(dadosBanco.port) || 5432
        };
        
        fs.writeFileSync(caminhoConfig, JSON.stringify(config, null, 2));
        return { status: 'sucesso' };
    } catch (err) {
        console.error("Erro ao salvar parâmetros do Postgres:", err);
        return { status: 'erro', message: err.message };
    }
});

// 🌟 NOVO: Canal para expor ao front-end se o Postgres conseguiu inicializar online
ipcMain.handle('verificar-status-rede-banco', async () => {
    return { isOnline: db.isOnline };
});