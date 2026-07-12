const { app, BrowserWindow, ipcMain } = require('electron'); // 🔒 CORRIGIDO: Única declaração de escopo necessária
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

// 🌟 CORRIGIDO E ATIVADO: Impressão assíncrona executando sem travas de concorrência
// 🌟 CORRIGIDO: Layout idêntico ao modelo físico anexado (Bobina Térmica 80mm)
ipcMain.handle('imprimir-comprovante-crediario', async (event, vendaId) => {
    try {
        console.log(`[MAIN] Capturando dados para cupom de crediário. ID: ${vendaId}`);
        const venda = await db.vendas.obterDadosCupomCrediario(vendaId);
        if (!venda) {
            console.error(`[MAIN] Venda com ID ${vendaId} não foi localizada para impressão.`);
            return { status: 'erro', mensagem: 'Venda não localizada.' };
        }

        const parcelas = await db.vendas.obterParcelasCupomCrediario(vendaId);
        const idCurto = venda.id.substring(0, 8);
        
        // Formata a data e hora de venda no padrão do anexo
        const dataVendaFormatada = new Date(venda.data_venda || Date.now())
            .toLocaleString('pt-BR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            .replace(',', '');

        // 🖨️ MONTAGEM DO HTML COM OS ESTILOS VISUAIS EXATOS DO CUPOM ANEXADO
        let htmlCupom = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                @page { margin: 0; }
                body {
                    font-family: 'Courier New', Courier, monospace;
                    width: 290px;
                    margin: 0;
                    padding: 10px;
                    font-size: 12px;
                    line-height: 1.3;
                    color: #000000;
                    background-color: #ffffff;
                }
                .text-center { text-align: center; }
                .text-right { text-align: right; }
                .bold { font-weight: bold; }
                .divisor {
                    border-top: 1px dashed #000000;
                    margin: 8px 0;
                }
                .tabela-parcelas {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 5px;
                }
                .tabela-parcelas th, .tabela-parcelas td {
                    padding: 2px 0;
                    font-size: 12px;
                }
                .termo-texto {
                    text-align: justify;
                    font-size: 11px;
                    line-height: 1.4;
                    margin-top: 10px;
                }
                .linha-assinatura {
                    margin-top: 45px;
                    border-top: 1px solid #000000;
                    width: 85%;
                    margin-left: auto;
                    margin-right: auto;
                }
            </style>
        </head>
        <body>
            <div class="text-center bold" style="font-size: 14px;">GRUPO ALFA VAREJO</div>
            <div class="text-center">CNPJ: 00.000.000/0001-00</div>
            <div class="text-center">FILIAL: ALFA MATRIZ</div>
            
            <div class="divisor"></div>
            
            <div class="text-center bold">COMPROVANTE DE CREDIÁRIO</div>
            <div class="text-center bold">NOTA PROMISSÓRIA</div>
            
            <div class="divisor"></div>
            
            <div><span class="bold">DOC Venda:</span> ${idCurto}</div>
            <div><span class="bold">Data/Hora:</span> ${dataVendaFormatada}</div>
            
            <div class="divisor"></div>
            
            <div><span class="bold">DEVEDOR:</span> ${venda.cliente_nome || 'Não Informado'}</div>
            <div><span class="bold">CPF:</span> ${venda.cliente_cpf || 'Não Informado'}</div>
            
            <div class="divisor"></div>
            
            <div class="bold">EXTRATO DAS PARCELAS:</div>
            <table class="tabela-parcelas">
                <thead>
                    <tr>
                        <th align="left" style="width: 20%;">Parc.</th>
                        <th align="center" style="width: 45%;">Vencimento</th>
                        <th align="right" style="width: 35%;">Valor</th>
                    </tr>
                </thead>
                <tbody>
        `;

        if (Array.isArray(parcelas) && parcelas.length > 0) {
            parcelas.forEach((p, idx) => {
                const dataVenc = new Date(p.data_vencimento).toLocaleDateString('pt-BR');
                const valorParc = parseFloat(p.valor || 0).toFixed(2);
                htmlCupom += `
                    <tr>
                        <td align="left">${idx + 1}/${parcelas.length}</td>
                        <td align="center">${dataVenc}</td>
                        <td align="right">R$ ${valorParc}</td>
                    </tr>
                `;
            });
        } else {
            // Fallback caso não venha a listagem fragmentada por algum motivo
            htmlCupom += `<tr><td colspan="3" class="text-center" style="font-style: italic;">Dados das parcelas indisponíveis</td></tr>`;
        }

        htmlCupom += `
                </tbody>
            </table>
            
            <div class="divisor"></div>
            
            <div class="text-right bold" style="font-size: 13px;">TOTAL DO DEBITO: R$ ${parseFloat(venda.total || 0).toFixed(2)}</div>
            
            <div class="divisor"></div>
            
            <div class="termo-texto">
                <span class="bold">TERMO DE CONFISSÃO DE DÍVIDA:</span> Pelo presente instrumento, confesso e me obrigo de forma irrevogável a pagar livre de despesas a quantia acima discriminada dividida nas respectivas faturas e vencimentos estipulados neste cupom.
            </div>
            
            <div class="linha-assinatura"></div>
            <div class="text-center bold" style="font-size: 11px; margin-top: 4px;">ASSINATURA DO CLIENTE</div>
            
            <br>
            <div class="text-center" style="font-size: 11px; margin-top: 10px;">Obrigado pela preferência!</div>
        </body>
        </html>
        `;

        // Instancia a janela invisível de renderização técnica (Worker)
        let workerWindow = new BrowserWindow({ 
            show: false, 
            webPreferences: { 
                nodeIntegration: true, 
                contextIsolation: false 
            } 
        });

        // 🌟 A SOLUÇÃO: Geramos uma Data URL contendo o título correto desde o nascimento da janela
        const base64Html = Buffer.from(htmlCupom).toString('base64');
        const dataUrl = `data:text/html;charset=utf-8;base64,${base64Html}`;

        // Carrega o conteúdo passando o título de contingência direto nos parâmetros da URL
        workerWindow.loadURL(dataUrl);

        workerWindow.webContents.on('did-finish-load', async () => {
            // Força a alteração no escopo do DOM por segurança
            await workerWindow.webContents.executeJavaScript(`
                document.title = "Comprovante_Crediario_${idCurto}";
            `);
            
            // Dispara para a fila do Spooler forçando o nome correto no Job do Sistema Operacional
            workerWindow.webContents.print({ 
                silent: true, 
                printBackground: true,
                margins: { marginType: 'none' },
                name: `Comprovante_Crediario_${idCurto}` // Nome do trabalho na fila do Windows/Spooler
            }, (success) => {
                workerWindow.close();
            });
        });

        return { status: 'sucesso' };
    } catch (err) {
        console.error("Erro ao processar impressão do crediário:", err.message);
        return { status: 'erro', mensagem: err.message };
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

// 🌟 Canal de auditoria do histórico de turnos repassando para o Database Manager
ipcMain.handle('obter-historico-turnos', async (event, filtros) => {
    if (!db.isOnline) {
        return { status: 'offline', mensagem: 'O histórico de auditoria global requer conexão ativa com o servidor PostgreSQL.' };
    }
    
    try {
        const dataInicio = filtros ? filtros.dataInicio : undefined;
        const dataFim = filtros ? filtros.dataFim : undefined;

        const dados = await db.obterHistoricoTurnos(dataInicio, dataFim);
        return { status: 'sucesso', dados };
    } catch (error) {
        return { status: 'offline', mensagem: error.message };
    }
});

// 🌟 Canal do extrato operacional detalhado de lançamentos do período
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

ipcMain.handle('inicializar-turno-operador', async (event, { usuario, senha, caixaId, manterConectado }) => {
    try {
        const operador = await db.realizarLogin(usuario, senha, caixaId);
        if (!operador) return { status: 'erro', mensagem: 'Usuário ou senha incorretos.' };

        await configService.salvarPropriedadeCriptografada('lembrarOperadorCriptografado', { usuario, senha });

        const dadosCaixa = await db.obterDadosCaixa(caixaId);
        const caixaEstaAberto = await db.verificarCaixaAberto(caixaId);

        if (caixaEstaAberto && dadosCaixa) {
            db.sincronizarOperadores().catch(() => {});
            db.sincronizarClientes().catch(() => {});
        }

        return {
            status: 'sucesso',
            operador,
            caixaEstaAberto,
            dadosCaixa: dadosCaixa || null
        };
    } catch (error) {
        return { status: 'erro', mensagem: error.message };
    }
});