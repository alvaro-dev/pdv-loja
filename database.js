const { Client } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');
const UsuarioRepository = require('./repositories/UsuarioRepository');
const ClienteRepository = require('./repositories/ClienteRepository');
const VendaRepository = require('./repositories/VendaRepository');
const CaixaRepository = require('./repositories/CaixaRepository');

// FUNCAO AUXILIAR: Gera data e hora local da máquina sem distorcao de fuso horario (UTC)
function obterDataHoraLocalANSI(dataBase = new Date()) {
    try {
        // Valida se o parametro passado e uma instancia de Date valida
        if (!(dataBase instanceof Date) || isNaN(dataBase.getTime())) {
            console.log("[AVISO] Parametro invalido enviado para obterDataHoraLocalANSI. Utilizando a data atual.");
            dataBase = new Date();
        }

        const ano = dataBase.getFullYear();
        const mes = String(dataBase.getMonth() + 1).padStart(2, '0');
        const dia = String(dataBase.getDate()).padStart(2, '0');
        const hora = String(dataBase.getHours()).padStart(2, '0');
        const minuto = String(dataBase.getMinutes()).padStart(2, '0');
        const segundo = String(dataBase.getSeconds()).padStart(2, '0');

        // Retorna exatamente no formato "YYYY-MM-DD HH:MM:SS" (ex: 2026-07-06 20:30:41)
        return `${ano}-${mes}-${dia} ${hora}:${minuto}:${segundo}`;
    } catch (err) {
        console.error("[ERRO CRITICO - obterDataHoraLocalANSI]: Falha ao processar formatacao de data ANSI:", err.message);
        
        // Retorno de contingencia segura baseado no horario do sistema atual caso o bloco principal falhe
        const fallback = new Date();
        return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, '0')}-${String(fallback.getDate()).padStart(2, '0')} ${String(fallback.getHours()).padStart(2, '0')}:${String(fallback.getMinutes()).padStart(2, '0')}:${String(fallback.getSeconds()).padStart(2, '0')}`;
    }
}

class DatabaseManager {
    constructor() {
        this.isOnline = false;
        this.pgClient = null;
        this.sqliteDb = null;
        
        // 🌐 VARIÁVEIS GLOBAIS DE TENANT DO TERMINAL
        this.tenantEmpresaId = null;
        this.tenantFilialId = null;
        this.escoposCache = {}; // 🌟 Cache global de escopos

        // 🌟 INICIALIZAÇÃO DO REPOSITÓRIO PASSANDO ESTA INSTÂNCIA DO GERENCIADOR
        this.usuarios = new UsuarioRepository(this);
        this.clientes = new ClienteRepository(this);
        this.vendas = new VendaRepository(this);
        this.caixas = new CaixaRepository(this);

        // No Windows, salva o arquivo .db na pasta AppData do usuário
        this.sqlitePath = path.join(app.getPath('userData'), 'pdv_local.db');
    }

    // 🔒 Função auxiliar para criptografar a senha em SHA-256 antes de comparar ou salvar
    gerarHashSenha(senha) {
        return crypto.createHash('sha256').update(senha).digest('hex');
    }

    // 🌟 FUNÇÃO AUXILIAR: Retorna a regra de escopo direto da memória sem ir ao banco
    obterEscopoTabela(tabelaNome) {
        const nomeLimpo = String(tabelaNome).toLowerCase();
        // Se a regra existir no cache, retorna ela, senão assume o padrão seguro 'EXCLUSIVO'
        return this.escoposCache[nomeLimpo] || 'EXCLUSIVO';
    }

    async realizarLogin(usuario, senha, caixaId) {
        try {
            const usuarioStr = String(usuario || '').trim();
            const senhaStr = String(senha || '').trim();
            const caixaIdStr = caixaId ? String(caixaId).trim() : null;
            
            console.log("[DB-LOGIN] Entrando na verificação via Repository...");

            const senhaCriptografada = (senhaStr.length === 64) 
                ? senhaStr 
                : this.usuarios.gerarHashSenha(senhaStr);
            
            let operador = null;

            // 1. Tenta autenticação Online
            if (this.isOnline) {
                try {
                    operador = await this.usuarios.buscarNoPostgres(usuarioStr, senhaCriptografada);
                    if (operador) {
                        // Sincroniza o operador autenticado em background
                        this.usuarios.espelharOperadorLocal(operador, senhaCriptografada).catch(err => {
                            console.error("[ERRO SINC] Falha ao espelhar operador:", err.message);
                        });
                    }
                } catch (err) {
                    console.error("[ERRO - Postgres Login]: Remote off, usando contingência.", err.message);
                    this.isOnline = false;
                }
            }

            // 2. Modo contingência offline
            if (!operador) {
                operador = await this.usuarios.buscarNoSQLite(usuarioStr, senhaCriptografada);
            }

            if (!operador) return null;

            // Admins ignoram travas de turno
            if (operador.role === 'admin' || operador.usuario === 'admin') return operador;

            // 3. Trava A: Verifica propriedade do terminal
            if (caixaIdStr) {
                let caixaDono = null;
                if (this.isOnline) {
                    try {
                        caixaDono = await this.usuarios.obterDonoTurnoAtivoPostgres(caixaIdStr);
                    } catch (err) { this.isOnline = false; }
                }
                if (!this.isOnline) {
                    caixaDono = await this.usuarios.obterDonoTurnoAtivoSQLite(caixaIdStr);
                }

                if (caixaDono && caixaDono.operador_abertura_id !== operador.id) {
                    throw new Error(`Este terminal já possui um turno ativo do operador: "${caixaDono.dono_nome}". Finalize o turno atual antes de trocar de operador.`);
                }
            }

            // 4. Trava B: Verifica duplicidade de turno ativo em outros caixas
            let turnoAtivo = null;
            if (this.isOnline) {
                try {
                    turnoAtivo = await this.usuarios.obterCaixaAbertoPorOperadorPostgres(operador.id);
                } catch (err) { this.isOnline = false; }
            }
            if (!this.isOnline) {
                turnoAtivo = await this.usuarios.obterCaixaAbertoPorOperadorSQLite(operador.id);
            }

            if (turnoAtivo && String(turnoAtivo.cod_caixa).trim() !== caixaIdStr) {
                throw new Error(`Este operador já possui um turno aberto no terminal: "${turnoAtivo.caixa_nome}". Encerre a outra sessão antes.`);
            }

            return operador;
        } catch (errGlobal) {
            console.error("[ERRO CRITICO - realizarLogin]:", errGlobal.message);
            throw errGlobal;
        }
    }

    // Atualize por completo o método obterDadosCaixa
    async obterDadosCaixa(caixaId) {
        try {
            console.log("[BANCO] Solicitando dados de governança do terminal ao CaixaRepository...");
            let caixaLocal = null;

            try {
                // Tenta carregar a última configuração armazenada em disco localmente
                caixaLocal = await this.caixas.buscarCadastroLocal(caixaId);
            } catch (errLite) {
                console.error("[ERRO - obterDadosCaixa Local SQLite]:", errLite.message);
            }

            // Se localizou e o escopo de governança do tenant estiver íntegro, alimenta a sessão
            if (caixaLocal && caixaLocal.empresa_id && caixaLocal.filial_id) {
                console.log("[LOCAL] Identificadores de Empresa e Filial carregados do SQLite.");
                
                this.tenantEmpresaId = caixaLocal.empresa_id;
                this.tenantFilialId = caixaLocal.filial_id;

                return {
                    id: caixaLocal.id,
                    descricao: caixaLocal.descricao,
                    empresa_id: caixaLocal.empresa_id,
                    filial_id: caixaLocal.filial_id,
                    empresa_nome: "Grupo Alfa Varejo",
                    filial_nome: "Alfa Matriz"
                };
            }

            // Se não encontrou dados locais, faz o fetch online no PostgreSQL
            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Buscando configurações de governança do caixa na nuvem...");
                    const caixaRemoto = await this.caixas.buscarCadastroPostgres(caixaId);
                    
                    if (caixaRemoto) {
                        this.tenantEmpresaId = caixaRemoto.empresa_id;
                        this.tenantFilialId = caixaRemoto.filial_id;
                        
                        try {
                            // Salva a carga estruturada no SQLite local para viabilizar os próximos boots offline
                            await this.caixas.salvarCargaLocal(caixaRemoto);
                            console.log("[POSTGRES] Carga de governança atualizada no SQLite Local.");
                        } catch (errSaveLite) {
                            console.error("[ERRO - obterDadosCaixa Salvar Carga]:", errSaveLite.message);
                        }
                        
                        return {
                            id: caixaRemoto.id,
                            descricao: caixaRemoto.descricao,
                            empresa_id: caixaRemoto.empresa_id,
                            filial_id: caixaRemoto.filial_id,
                            empresa_nome: "Grupo Alfa Varejo",
                            filial_nome: "Alfa Matriz"
                        };
                    } else {
                        console.log("[POSTGRES] Nenhum registro localizado para o ID informado.");
                    }
                } catch (err) {
                    console.error("[ERRO - obterDadosCaixa Postgres]:", err.message);
                    this.isOnline = false;
                }
            }

            console.log("[BANCO] Retornando última instância conhecida do caixa local.");
            return caixaLocal; 

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - obterDadosCaixa FATAL]:", errGlobal.message);
            return null;
        }
    }

    // 🌟 MODIFICADO: 100% isolado de queries SQL nativas através do padrão Repository Pattern
    async init(configBanco) {
        try {
            console.log(`[Banco Local] Caminho do SQLite: ${this.sqlitePath}`);

            // 1. Inicializa o SQLite (Sempre ativo como porto seguro/contingência)
            try {
                this.sqliteDb = new sqlite3.Database(this.sqlitePath);
                console.log("[DATABASE] Instancia do arquivo SQLite inicializada.");
            } catch (errSqliteInit) {
                console.error("[ERRO CRITICO - init (Criar SQLite)]: Falha ao abrir arquivo de banco local:", errSqliteInit.message);
                throw errSqliteInit;
            }

            try {
                this.initSQLiteTables();
                console.log("[DATABASE] Estrutura de tabelas locais validadas/criadas.");
            } catch (errTables) {
                console.error("[ERRO CRITICO - init (initSQLiteTables)]: Falha ao estruturar tabelas locais:", errTables.message);
                throw errTables;
            }

            // 2. Validação das Credenciais do PostgreSQL externas
            if (!configBanco || !configBanco.host || !configBanco.database || !configBanco.user || !configBanco.password) {
                this.isOnline = false;
                console.log("==========================================================================");
                console.error("ERRO CONEXAO POSTGRESQL: Parametros invalidos ou nao existem no config.json!");
                console.log("Conectando em modo OFFLINE de contingencia (Apenas SQLite Local Ativo).");
                console.log("==========================================================================");
                return; 
            }

            // 3. Se passou na validação do JSON, tenta conectar no Postgres físico
            try {
                this.pgClient = new Client({
                    host: configBanco.host, 
                    database: configBanco.database,
                    user: configBanco.user,
                    password: configBanco.password,
                    port: parseInt(configBanco.port) || 5432,
                    connectionTimeoutMillis: 3000
                });

                console.log("[DATABASE] Estabelecendo handshake de rede com o servidor PostgreSQL remoto...");
                await this.pgClient.connect();
                this.isOnline = true;
                console.log("[DATABASE] Conectado ao PostgreSQL externo com sucesso!");

                // Carrega todas as regras de escopo na inicialização usando o Repository especialista
                this.escoposCache = {};
                try {
                    const linhasEscopos = await this.caixas.buscarEscoposTabelasPostgres();
                    linhasEscopos.forEach(row => {
                        this.escoposCache[row.tabela_nome.toLowerCase()] = String(row.escopo).toUpperCase();
                    });
                    console.log("[DATABASE] Cache de regras de escopo carregado com sucesso:", this.escoposCache);
                } catch (errEscopo) {
                    console.error("[ERRO - init (buscarEscoposTabelasPostgres)]: Falha ao carregar tabela de escopos, usando padroes EXCLUSIVO:", errEscopo.message);
                }
            } catch (err) {
                this.isOnline = false;
                console.error(`[DATABASE] Servidor Postgres inacessivel (${err.message}). Modo OFFLINE ativo.`);
            }

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - init FATAL]: Falha geral nao tratada na inicializacao dos motores de banco de dados:", errGlobal.message);
        }
    }

    initSQLiteTables() {

        // 1. Tabela de usuarios Locais
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS usuarios_locais (
                id TEXT PRIMARY KEY,
                usuario TEXT UNIQUE NOT NULL,
                nome TEXT NOT NULL,
                senha TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'operador',
                bloqueado TEXT NOT NULL DEFAULT 'N',
                deletado INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
                usuario_pdv TEXT NOT NULL DEFAULT 'N',
                trocar_senha_prox_login TEXT NOT NULL DEFAULT 'N',
                data_alteracao TEXT DEFAULT '1970-01-01 00:00:00' -- 🌟 NOVO
            )
        `);
        
        // 2. Cria a tabela de caixas locais (Controle do Terminal com Tenant)
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS caixas_locais (
                id TEXT PRIMARY KEY,
                descricao TEXT NOT NULL,
                empresa_id TEXT,    -- 🌟 ADICIONADO PARA CONTINGÊNCIA OFFLINE
                filial_id TEXT,     -- 🌟 ADICIONADO PARA CONTINGÊNCIA OFFLINE
                bloqueado TEXT NOT NULL DEFAULT 'N',
                deletado INTEGER DEFAULT 0
            )
        `);
        
        // 3. Cria a nova tabela de vendas locais
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS vendas_locais (
                id TEXT PRIMARY KEY,
                caixa_id TEXT NOT NULL,
                operador_id TEXT NOT NULL,
                cliente_id TEXT DEFAULT '00000000-0000-0000-0000-000000000000',
                forma_pagamento TEXT NOT NULL,
                origem TEXT NOT NULL,
                total REAL NOT NULL,
                descricao_movimento TEXT,
                data_venda TEXT NOT NULL,
                sincronizado INTEGER DEFAULT 0,
                deletado INTEGER DEFAULT 0,
                bandeira TEXT,         
                parcelas INTEGER DEFAULT 1 
            )
        `);
        
        // 4. Tabela de Movimentos de Caixa (Turnos)
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS movimentos_caixa_locais (
                id TEXT PRIMARY KEY,
                caixa_id TEXT NOT NULL,
                operador_abertura_id TEXT NOT NULL,
                operador_fechamento_id TEXT,
                data_abertura TEXT NOT NULL,
                data_fechamento TEXT,
                valor_abertura REAL NOT NULL,
                valor_fechamento REAL,
                valor_contado REAL,
                diferenca REAL,
                status TEXT NOT NULL DEFAULT 'A',
                sincronizado INTEGER DEFAULT 0,
                deletado INTEGER DEFAULT 0
            )
        `);

        // 5. Tabela de Recebíveis Cartao de Crédito Locais:
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS recebiveis_cartao_locais (
                id TEXT PRIMARY KEY,
                venda_id TEXT NOT NULL,
                caixa_id TEXT NOT NULL,
                parcela_numero INTEGER NOT NULL,
                valor_parcela REAL NOT NULL,
                data_prevista_recebimento TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'P', -- P = Pendente, R = Recebido
                sincronizado INTEGER DEFAULT 0,
                deletado INTEGER DEFAULT 0
            )
        `);
        
        // 6. Tabela de Clientes Locais
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS clientes_locais (
                id TEXT PRIMARY KEY,
                empresa_id TEXT NOT NULL,
                filial_id TEXT, -- Pode ser NULL se for COMPARTILHADO no Postgres
                nome TEXT NOT NULL,
                cpf TEXT,
                limite_credito REAL DEFAULT 0.00,
                bloqueado TEXT NOT NULL DEFAULT 'N',
                deletado INTEGER NOT NULL DEFAULT 0,
                data_alteracao TEXT DEFAULT '1970-01-01 00:00:00' -- 🌟 NOVO
            )
        `);

        // 7. Tabela de Apoio ao Crediário Local (Versão Ultra-Leve e Simplificada)
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS contas_a_receber_locais (
                id TEXT PRIMARY KEY,
                venda_id TEXT NOT NULL,
                cliente_id TEXT NOT NULL,
                data_vencimento TEXT NOT NULL,
                valor_original REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'P', -- 'P' = Pendente, 'R' = Recebido
                sincronizado INTEGER DEFAULT 0,
                deletado INTEGER DEFAULT 0
            )
        `);
    }

    async sincronizarOperadores() {
        if (!this.pgClient) return { status: 'offline' };
        
        try {
            if (!this.tenantEmpresaId || !this.tenantFilialId) {
                return { status: 'erro', mensagem: 'IDs de governança ausentes no boot.' };
            }

            const ultimaAtualizacao = await this.usuarios.obterUltimaAtualizacaoLocal();
            console.log(`[SYNC-OPERADORES] Executando busca incremental pós: ${ultimaAtualizacao}`);
            
            const operadoresNovos = await this.usuarios.buscarModificadosPostgres(this.tenantEmpresaId, this.tenantFilialId, ultimaAtualizacao);

            if (operadoresNovos.length === 0) return { status: 'sucesso', total: 0 };

            await this.usuarios.salvarLoteLocal(operadoresNovos);
            return { status: 'sucesso', total: operadoresNovos.length };
        } catch (error) {
            console.error("[SYNC] Erro no lote de operadores:", error.message);
            return { status: 'erro', mensagem: error.message };
        }
    }

    async sincronizarClientes() {
        if (!this.pgClient) return { status: 'offline' };

        try {
            if (!this.tenantEmpresaId) {
                return { status: 'erro', mensagem: 'IDs de governança ausentes no boot.' };
            }

            const escopoAtual = this.obterEscopoTabela('clientes');
            const ultimaAtualizacao = await this.clientes.obterUltimaAtualizacaoLocal();

            console.log(`[SYNC-CLIENTES] Verificando novos clientes pós: ${ultimaAtualizacao} | Escopo: ${escopoAtual}`);

            const clientesNovos = await this.clientes.buscarModificadosPostgres(
                this.tenantEmpresaId, 
                this.tenantFilialId, 
                ultimaAtualizacao, 
                escopoAtual
            );

            if (clientesNovos.length === 0) return { status: 'sucesso', total: 0 };

            console.log(`[SYNC-CLIENTES] Salvando ${clientesNovos.length} novos registros modificados no SQLite...`);
            await this.clientes.salvarLoteLocal(clientesNovos);
            
            return { status: 'sucesso', total: clientesNovos.length };

        } catch (error) {
            console.error("[SYNC-CLIENTES] Erro fatal no lote incremental:", error.message);
            return { status: 'erro', mensagem: error.message };
        }
    }

    async buscarClientesLocais(termoBusca) {
        try {
            console.log("[BANCO] Buscando clientes via ClienteRepository...");
            const termo = `%${String(termoBusca || '').trim()}%`;
            return await this.clientes.buscarLocaisPorTermo(termo);
        } catch (errGlobal) {
            console.error("[ERRO CRITICO - buscarClientesLocais]:", errGlobal.message);
            return [];
        }
    }

    async verificarCaixaAberto(caixaId) {
        try {
            if (this.isOnline) {
                try {
                    console.log("[BANCO] Verificando status de abertura via CaixaRepository (Postgres)...");
                    return await this.caixas.verificarTurnoAbertoPostgres(caixaId);
                } catch (err) {
                    console.error("[ERRO - verificarCaixaAberto Postgres]:", err.message);
                    this.isOnline = false;
                }
            }
            
            console.log("[BANCO] Verificando status de abertura via CaixaRepository (SQLite)...");
            return await this.caixas.verificarTurnoAbertoSQLite(caixaId);
        } catch (errGlobal) {
            console.error("[ERRO CRITICO - verificarCaixaAberto FATAL]:", errGlobal.message);
            return false;
        }
    }

    async abrirCaixa(caixaId, operadorId, valorAbertura) {
        try {
            console.log("[BANCO] Iniciando processo de abertura via CaixaRepository...");
            
            const idMovimento = crypto.randomUUID();
            const dataAtual = obterDataHoraLocalANSI();

            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;

            const payloadMovimento = { id: idMovimento, caixaId, operadorId, dataAbertura: dataAtual, valorAbertura };

            if (this.isOnline) {
                try {
                    if (!empIdGlobal) throw new Error("Dados de governança ausentes no escopo.");

                    const escopoTurnos = this.obterEscopoTabela('movimentos_caixa');
                    const filialPgValor = (escopoTurnos === 'COMPARTILHADO') ? null : filIdGlobal;

                    await this.caixas.inserirAberturaPostgres(payloadMovimento, empIdGlobal, filialPgValor);
                    console.log("[BANCO] Turno de caixa aberto com sucesso no PostgreSQL.");
                } catch (err) {
                    console.error("[BANCO] Erro ao abrir no Postgres, recuando para contingência:", err.message);
                    this.isOnline = false;
                }
            }

            const jaSincronizado = this.isOnline ? 1 : 0;
            await this.caixas.inserirAberturaSQLite(payloadMovimento, jaSincronizado);
            
            console.log(`[BANCO] Turno aberto com sucesso no SQLite (Sincronizado: ${jaSincronizado}).`);
            return { status: 'sucesso', id: idMovimento };

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - abrirCaixa FATAL]:", errGlobal.message);
            throw errGlobal;
        }
    }

    async registrarVenda(caixaId, operadorId, total, formaPagamento, origem, descricaoMovimento, bandeira = null, parcelas = 1, clienteId = '00000000-0000-0000-0000-000000000000') {
        try {
            console.log("[BANCO] Processando persistência via VendaRepository...");
            
            const idVenda = crypto.randomUUID();
            const dataAtual = obterDataHoraLocalANSI();

            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;

            // 1. Salva o cabeçalho da venda pai localmente
            const payloadVenda = { id: idVenda, caixaId, operadorId, clienteId, formaPagamento, origem, total, descricaoMovimento, dataVenda: dataAtual, bandeira, parcelas };
            await this.vendas.inserirVendaPaiSQLite(payloadVenda);

            // 2. Desmembra parcelas de Crediário localmente
            if (formaPagamento === 'CR' && total > 0) {
                const valorPorParcela = total / parcelas;
                for (let i = 1; i <= parcelas; i++) {
                    const dataVencimento = new Date();
                    dataVencimento.setDate(dataVencimento.getDate() + (30 * i));
                    
                    await this.vendas.inserirParcelaCrediarioSQLite({
                        id: crypto.randomUUID(),
                        vendaId: idVenda,
                        clienteId,
                        dataVencimento: obterDataHoraLocalANSI(dataVencimento).split(' ')[0],
                        valorOriginal: valorPorParcela
                    });
                }
            }

            // 3. Desmembra parcelas de Cartão localmente
            if (formaPagamento === 'CC' && total > 0) {
                const valorPorParcela = total / parcelas;
                for (let i = 1; i <= parcelas; i++) {
                    const dataPrevista = new Date();
                    dataPrevista.setDate(dataPrevista.getDate() + (30 * i));

                    await this.vendas.inserirParcelaCartaoSQLite({
                        id: crypto.randomUUID(),
                        vendaId: idVenda,
                        caixaId,
                        parcelaNumero: i,
                        valorParcela: valorPorParcela,
                        dataPrevista: obterDataHoraLocalANSI(dataPrevista)
                    });
                }
            }

            // 4. Replicação imediata na nuvem se estiver online
            if (this.isOnline) {
                try {
                    if (!empIdGlobal) throw new Error("Parâmetros de governança ausentes.");

                    const escopoVendas = this.obterEscopoTabela('vendas');
                    const filialPgValor = (escopoVendas === 'COMPARTILHADO') ? null : filIdGlobal;

                    // Envia a venda pai pro Postgres
                    await this.vendas.inserirVendaPaiPostgres(payloadVenda, empIdGlobal, filialPgValor);
                    
                    // Sincroniza lotes de crediário
                    // Upload assíncrono das parcelas de Crediário pro Postgres
                    if (formaPagamento === 'CR') {
                        const contasLocais = await this.vendas.obterContasReceberLocaisPorVenda(idVenda);
                        const escopoCR = this.obterEscopoTabela('contas_a_receber');
                        const filialCRPgValor = (escopoCR === 'COMPARTILHADO') ? null : filIdGlobal;

                        let nrP = 1;
                        for (const conta of contasLocais) {
                            // Invoca o repositório passando a entidade higienizada
                            await this.vendas.inserirContaReceberPostgres(conta, nrP, parcelas, dataAtual, empIdGlobal, filialCRPgValor);
                            this.vendas.marcarContaReceberSincronizada(conta.id);
                            nrP++;
                        }
                    }

                    // Sincroniza lotes de cartão
                    if (formaPagamento === 'CC') {
                        const escopoRecebiveis = this.obterEscopoTabela('recebiveis_cartao');
                        const filialRecPgValor = (escopoRecebiveis === 'COMPARTILHADO') ? null : filIdGlobal;

                        const recebiveis = await this.vendas.obterRecebiveisCartaoLocaisPorVenda(idVenda);
                        for (const rec of recebiveis) {
                            await this.vendas.inserirRecebivelCartaoPostgres(rec, empIdGlobal, filialRecPgValor);
                            this.vendas.marcarRecebivelCartaoSincronizado(rec.id);
                        }
                    }

                    this.vendas.marcarVendaSincronizada(idVenda);
                    return { status: 'sucesso', modo: 'ONLINE', id: idVenda };
                } catch (errPg) {
                    console.error("[BANCO] Erro de rede ao espelhar, operando em contingência:", errPg.message);
                    this.isOnline = false;
                }
            }

            return { status: 'sucesso', modo: 'OFFLINE (SQLite)', id: idVenda };
        } catch (errGlobal) {
            console.error("[ERRO CRITICO] Falha no pipeline de gravação:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async verificarConexaoPostgres() {
        if (!this.pgClient) return;
        try {
            // Executa um ping de infraestrutura puro para testar o socket de rede
            await this.pgClient.query('SELECT 1');
            if (!this.isOnline) {
                console.log("[CONEXÃO] Redes restabelecidas! O PDV voltou a ficar ONLINE.");
                this.isOnline = true;
            }
        } catch (err) {
            if (this.isOnline) {
                console.log("[CONEXÃO] O servidor Postgres caiu. O PDV agora está operando OFFLINE.");
                this.isOnline = false;
            }
        }
    }

    async sincronizarVendasPendentes() {
        try {
            if (!this.isOnline) return { status: 'offline' };

            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;
            if (!empIdGlobal) return { status: 'erro', mensagem: 'Governança ausente.' };

            const vendasPendentes = await this.vendas.obterVendasLocaisPendentes();
            if (vendasPendentes.length === 0) return { status: 'limpo', total: 0 };

            console.log(`[SYNC] Sincronizando ${vendasPendentes.length} vendas via Repository...`);

            const escopoVendas = this.obterEscopoTabela('vendas');
            const filialPgValor = (escopoVendas === 'COMPARTILHADO') ? null : filIdGlobal;

            for (const venda of vendasPendentes) {
                const payloadVenda = {
                    id: venda.id, caixaId: venda.caixa_id, operadorId: venda.operador_id,
                    clienteId: (venda.cliente_id === 'CONSUMIDOR-FINAL' || !venda.cliente_id) ? '00000000-0000-0000-0000-000000000000' : venda.cliente_id,
                    formaPagamento: venda.forma_pagamento, origem: venda.origem, total: venda.total,
                    descricaoMovimento: venda.descricao_movimento, dataVenda: venda.data_venda,
                    deletado: (venda.deletado === 1), bandeira: venda.bandeira, parcelas: venda.parcelas
                };

                // 1. Upload do cabeçalho pai
                await this.vendas.inserirVendaPaiPostgres(payloadVenda, empIdGlobal, filialPgValor);
                if (venda.deletado === 1) {
                    await this.vendas.marcarDeletadaPostgres(venda.id);
                }

                // 2. Upload de recebíveis pendentes (CC)
                if (venda.forma_pagamento === 'CC') {
                    const recebiveis = await this.vendas.obterRecebiveisCartaoLocaisPorVenda(venda.id);
                    const escopoRecebiveis = this.obterEscopoTabela('recebiveis_cartao');
                    const filialRecPgValor = (escopoRecebiveis === 'COMPARTILHADO') ? null : filIdGlobal;

                    for (const r of recebiveis) {
                        await this.vendas.inserirRecebivelCartaoPostgres(r, empIdGlobal, filialRecPgValor);
                        this.vendas.marcarRecebivelCartaoSincronizado(r.id);
                    }
                }

                // 3. Upload de parcelas pendentes (CR)
                if (venda.forma_pagamento === 'CR') {
                    const contasLocais = await this.vendas.obterContasReceberLocaisPorVenda(venda.id);
                    const escopoCR = this.obterEscopoTabela('contas_a_receber');
                    const filialCRPgValor = (escopoCR === 'COMPARTILHADO') ? null : filIdGlobal;

                    let nrP = 1;
                    for (const conta of contasLocais) {
                        await this.vendas.inserirContaReceberPostgres(conta, nrP, venda.parcelas, venda.data_venda, empIdGlobal, filialCRPgValor);
                        this.vendas.marcarContaReceberSincronizada(conta.id);
                        nrP++;
                    }
                }

                this.vendas.marcarVendaSincronizada(venda.id);
            }

            return { status: 'sucesso', total: vendasPendentes.length };
        } catch (error) {
            console.error("[SYNC] Falha no lote incremental do repositório:", error.message);
            this.isOnline = false;
            return { status: 'erro_rede' };
        }
    }

    async obterResumoTurnoAtual(caixaId) {
        try {
            console.log("[BANCO] Levantando resumo do turno via CaixaRepository...");
            let movimento = null;
            
            if (this.isOnline) {
                try {
                    movimento = await this.caixas.obterMovimentoAtivoPostgres(caixaId);
                } catch (err) { 
                    console.error("[ERRO - obterResumoTurnoAtual Postgres]:", err.message);
                    this.isOnline = false; 
                }
            }
            
            if (!movimento) {
                movimento = await this.caixas.obterMovimentoAtivoSQLite(caixaId);
            }

            if (!movimento) {
                return { status: 'erro', mensagem: 'Nenhum turno aberto encontrado para este caixa.' };
            }

            const dataAberturaTurno = movimento.data_abertura || movimento.dataAbertura;
            let vendas = [];

            if (this.isOnline) {
                try {
                    vendas = await this.caixas.listarVendasParaResumoPostgres(caixaId, dataAberturaTurno);
                } catch (err) { 
                    console.error("[ERRO - obterResumoTurnoAtual Listar Postgres]:", err.message);
                    this.isOnline = false; 
                }
            }
            
            if (!this.isOnline) {
                vendas = await this.caixas.listarVendasParaResumoSQLite(caixaId, dataAberturaTurno);
            }

            let totalEntradas = 0;
            let totalSaidas = 0;

            const detalheFormas = {
                DN: { nome: 'Dinheiro', entradas: 0, saidas: 0 },
                CC: { nome: 'Cartao de Credito', entradas: 0, saidas: 0 },
                CD: { nome: 'Cartao de Debito', entradas: 0, saidas: 0 },
                PX: { nome: 'Pix', entradas: 0, saidas: 0 },
                CR: { nome: 'Crediario', entradas: 0, saidas: 0 }
            };

            vendas.forEach(v => {
                const valor = parseFloat(v.total || v.valor || 0);
                const forma = v.forma_pagamento;

                if (detalheFormas[forma]) {
                    if (v.origem === 'E') {
                        totalEntradas += valor;
                        detalheFormas[forma].entradas += valor;
                    } else if (v.origem === 'S') {
                        totalSaidas += valor;
                        detalheFormas[forma].saidas += valor;
                    }
                }
            });

            const fundoInicial = parseFloat(movimento.valor_abertura || movimento.valorAbertura || 0);
            const saldoFinal = fundoInicial + totalEntradas - totalSaidas;

            return {
                movimentoId: movimento.id,
                fundoInicial,
                totalEntradas,
                totalSaidas,
                saldoFinal,
                detalheFormas: Object.values(detalheFormas)
            };

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - obterResumoTurnoAtual FATAL]:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async fecharCaixa(movimentoId, operadorFechamentoId, valorFechamento, valorContado, diferenca) {
        try {
            console.log("[BANCO] Processando fechamento de turno via CaixaRepository...");
            const dataAtual = obterDataHoraLocalANSI();

            const payloadFechamento = { movimentoId, operadorFechamentoId, valorFechamento, valorContado, diferenca };

            if (this.isOnline) {
                try {
                    await this.caixas.atualizarFechamentoPostgres(payloadFechamento, dataAtual);
                    console.log("[BANCO] Turno encerrado no PostgreSQL.");
                } catch (err) { 
                    console.error("[ERRO - fecharCaixa Postgres]:", err.message);
                    this.isOnline = false; 
                }
            }

            const jaSincronizadoFec = this.isOnline ? 1 : 0;
            await this.caixas.atualizarFechamentoSQLite(payloadFechamento, dataAtual, jaSincronizadoFec);
            
            console.log(`[BANCO] Turno de caixa fechado localmente (Sincronizado: ${jaSincronizadoFec}).`);
            return { status: 'sucesso' };

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - fecharCaixa FATAL]:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async excluirLancamento(vendaId) {
        try {
            console.log("[BANCO] Executando exclusão via VendaRepository...");

            if (this.isOnline) {
                try {
                    await this.vendas.marcarDeletadaPostgres(vendaId);
                    await this.vendas.marcarDeletadaLocal(vendaId, 1); // Grava localmente como já sincronizado
                    return { status: 'sucesso' };
                } catch (err) {
                    console.error("[BANCO] Servidor offline no delete, usando contingência local:", err.message);
                    this.isOnline = false;
                }
            }

            // Contingência offline pura
            await this.vendas.marcarDeletadaLocal(vendaId, 0); // Grava localmente marcando pendência de sync
            return { status: 'sucesso' };
        } catch (errGlobal) {
            console.error("[ERRO CRITICO - excluirLancamento]:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async listarVendasTurnoAtual(caixaId) {
        try {
            console.log("[BANCO] Solicitando listagem do grid de faturamento ao VendaRepository...");
            let movimento = null;

            // Reutiliza a busca de movimento ativo que encapsulamos no CaixaRepository
            if (this.isOnline) {
                try {
                    movimento = await this.caixas.obterMovimentoAtivoPostgres(caixaId);
                } catch (err) { 
                    console.error("[ERRO - listarVendasTurnoAtual Abertura Postgres]:", err.message);
                    this.isOnline = false; 
                }
            }

            if (!movimento) {
                movimento = await this.caixas.obterMovimentoAtivoSQLite(caixaId);
            }

            if (!movimento) {
                console.log("[BANCO] Listagem cancelada: Nenhum turno aberto localizado.");
                return [];
            }

            const dataAberturaTurno = movimento.data_abertura || movimento.dataAbertura;

            // Busca os lançamentos do grid através do repositório especialista de Vendas
            if (this.isOnline) {
                try {
                    return await this.vendas.listarVendasTurnoPostgres(caixaId, dataAberturaTurno);
                } catch (err) { 
                    console.error("[ERRO - listarVendasTurnoPostgres]:", err.message);
                    this.isOnline = false; 
                }
            }
            
            return await this.vendas.listarVendasTurnoSQLite(caixaId, dataAberturaTurno);

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - listarVendasTurnoAtual FATAL]:", errGlobal.message);
            return [];
        }
    }

    async obterHistoricoTurnos(dataInicio, dataFim) {
        if (this.isOnline) {
            try {
                console.log("[BANCO] Consultando histórico de turnos via CaixaRepository...");
                return await this.caixas.obterHistoricoTurnosPostgres(dataInicio, dataFim);
            } catch (err) {
                this.isOnline = false;
                throw new Error("Conexão perdida com o servidor Linux PostgreSQL.");
            }
        }
        throw new Error("O sistema encontra-se em modo de contingência offline.");
    }

    async obterVendasPorPeriodo(caixaId, dataAbertura, dataFechamento) {
        // Função utilitária mantida idêntica para higienizar strings de timestamps locais da máquina
        const extrairTimestampLocal = (dataStr) => {
            if (!dataStr || dataStr === 'N/A' || dataStr === 'Finalizado') return null;
            try {
                if (dataStr.includes(',')) {
                    const [data, hora] = dataStr.split(', ');
                    const [dia, mes, ano] = data.split('/');
                    return `${ano}-${mes}-${dia} ${hora}`;
                }
                const d = new Date(dataStr);
                if (isNaN(d.getTime())) return null;
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
            } catch (e) { return null; }
        };

        const dataInicioClean = extrairTimestampLocal(dataAbertura);
        const dataFimClean = extrairTimestampLocal(dataFechamento);

        console.log(`[BANCO] Buscando período estrito via CaixaRepository: ${dataInicioClean} até ${dataFimClean}`);

        if (this.isOnline) {
            try {
                const empIdGlobal = this.tenantEmpresaId;
                const filIdGlobal = this.tenantFilialId;

                if (!empIdGlobal) {
                    throw new Error('Dados de governança (Empresa ID) ausentes no escopo em memória.');
                }

                return await this.caixas.obterVendasPorPeriodoPostgres(
                    caixaId, dataInicioClean, dataFimClean, empIdGlobal, filIdGlobal
                );
            } catch (err) {
                console.error("ERRO NO EXTRACT PDV POSTGRES:", err.message);
                throw err;
            }
        }

        throw new Error("O sistema encontra-se em modo de contingência offline.");
    }

    // 📊 Retorna o total de linhas e itens pendentes de sincronização do SQLite local
    async obterStatusSincronizacao() {
        try {
            console.log("[BANCO] Solicitando auditoria de contadores ao CaixaRepository...");
            return await this.caixas.obterStatusSincronizacaoSQLite();
        } catch (errGlobal) {
            console.error("[ERRO CRITICO - obterStatusSincronizacao FATAL]:", errGlobal.message);
            return {
                vendas: { total: 0, pendentes: 0 },
                turnos: { total: 0, pendentes: 0 },
                recebiveis: { total: 0, pendentes: 0 },
                crediario: { total: 0, pendentes: 0 }
            };
        }
    }

    // 🔄 Executa a sincronização manual por tabela e retorna uma lista de strings de log para a tela
    async sincronizarTabelaManual(tipo) {
        try {
            if (!this.isOnline || !this.pgClient) {
                throw new Error("Sem conexao ativa com o servidor PostgreSQL central.");
            }
            
            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;

            if (!empIdGlobal) {
                throw new Error("Erro de escopo: Identificadores de governanca do terminal nao estao carregados.");
            }

            const logs = [];
            logs.push(`[${new Date().toLocaleTimeString()}] 🚀 Iniciando sincronizacao da tabela: ${tipo.toUpperCase()}`);

            // ==========================================
            // SUB-FLUXO: VENDAS
            // ==========================================
            if (tipo === 'vendas') {
                const pendentes = await this.caixas.obterVendasPendentesManual();
                logs.push(`[INFO] Encontrados ${pendentes.length} lancamentos pendentes.`);
                
                const escopoVendas = this.obterEscopoTabela('vendas');
                const filialPgValor = (escopoVendas === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const v of pendentes) {
                    try {
                        const payloadVenda = {
                            id: v.id, caixaId: v.caixa_id, operadorId: v.operador_id,
                            clienteId: (v.cliente_id === 'CONSUMIDOR-FINAL' || !v.cliente_id) ? '00000000-0000-0000-0000-000000000000' : v.cliente_id,
                            formaPagamento: v.forma_pagamento, origem: v.origem, total: v.total,
                            descricaoMovimento: v.descricao_movimento, dataVenda: v.data_venda,
                            bandeira: v.bandeira, parcelas: v.parcelas
                        };

                        await this.vendas.inserirVendaPaiPostgres(payloadVenda, empIdGlobal, filialPgValor);
                        if (v.deletado === 1) {
                            await this.vendas.marcarDeletadaPostgres(v.id);
                        }
                        
                        this.vendas.marcarVendaSincronizada(v.id);
                        logs.push(`[SUCESSO] Lancamento ID ${v.id.substring(0,8)}... espelhado com a nuvem.`);
                    } catch (errLoopVenda) {
                        logs.push(`[FALHA] Nao foi possivel espelhar a venda ID ${v.id.substring(0,8)}: ${errLoopVenda.message}`);
                    }
                }
            }
            // ==========================================
            // SUB-FLUXO: TURNOS
            // ==========================================
            else if (tipo === 'turnos') {
                const pendentes = await this.caixas.obterTurnosPendentesManual();
                logs.push(`[INFO] Encontrados ${pendentes.length} fechamentos de turnos pendentes.`);

                const escopoTurnos = this.obterEscopoTabela('movimentos_caixa');
                const filialPgValor = (escopoTurnos === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const t of pendentes) {
                    try {
                        const payloadFechamento = {
                            movimentoId: t.id, operadorFechamentoId: t.operador_fechamento_id,
                            valorFechamento: t.valor_fechamento, valorContado: t.valor_contado, diferenca: t.diferenca
                        };

                        await this.caixas.inserirAberturaPostgres({
                            id: t.id, caixaId: t.caixa_id, operadorId: t.operador_abertura_id, dataAbertura: t.data_abertura, valorAbertura: t.valor_abertura
                        }, empIdGlobal, filialPgValor);

                        if (t.status === 'F') {
                            await this.caixas.atualizarFechamentoPostgres(payloadFechamento, t.data_fechamento);
                        }

                        // 🌟 CORRIGIDO: Removido o sqliteDb.run cru e substituído pelo método do repositório
                        await this.caixas.marcarTurnoSincronizado(t.id);

                        logs.push(`[SUCESSO] Turno ID ${t.id.substring(0,8)}... atualizado no PostgreSQL.`);
                    } catch (errLoopTurno) {
                        logs.push(`[FALHA] Nao foi possivel espelhar o turno ID ${t.id.substring(0,8)}: ${errLoopTurno.message}`);
                    }
                }
            }
            // ==========================================
            // SUB-FLUXO: RECEBÍVEIS CARTÃO
            // ==========================================
            else if (tipo === 'recebiveis') {
                const pendentes = await this.caixas.obterRecebiveisPendentesManual();
                logs.push(`[INFO] Encontrados ${pendentes.length} recebiveis de cartao pendentes.`);

                const escopoRecebiveis = this.obterEscopoTabela('recebiveis_cartao');
                const filialRecPgValor = (escopoRecebiveis === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const r of pendentes) {
                    try {
                        await this.vendas.inserirRecebivelCartaoPostgres(r, empIdGlobal, filialRecPgValor);
                        this.vendas.marcarRecebivelCartaoSincronizado(r.id);
                        logs.push(`[SUCESSO] Recebivel ID ${r.id.substring(0,8)}... espelhado com a nuvem.`);
                    } catch (errLoopRec) {
                        logs.push(`[FALHA] Nao foi possivel espelhar o recebivel ID ${r.id.substring(0,8)}: ${errLoopRec.message}`);
                    }
                }
            }
            // ==========================================
            // SUB-FLUXO: CREDIÁRIO
            // ==========================================
            else if (tipo === 'crediario') {
                const pendentes = await this.caixas.obterCrediariosPendentesManual();
                logs.push(`[INFO] Encontrados ${pendentes.length} titulos de parcelas de crediario pendentes.`);

                const escopoCR = this.obterEscopoTabela('contas_a_receber');
                const filialCRPgValor = (escopoCR === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const c of pendentes) {
                    try {
                        const vendaPai = await this.caixas.obterMetadadosVendaPai(c.venda_id);
                        const dataEmissao = vendaPai ? vendaPai.data_venda : obterDataHoraLocalANSI();
                        const totalParcelasVenda = vendaPai ? vendaPai.parcelas : 1;

                        const ordemParcela = await this.caixas.obterIndiceOrdemParcela(c.venda_id, c.id);

                        await this.vendas.inserirContaReceberPostgres(c, ordemParcela, totalParcelasVenda, dataEmissao, empIdGlobal, filialCRPgValor);
                        this.vendas.marcarContaReceberSincronizada(c.id);
                        logs.push(`[SUCESSO] Parcela ${ordemParcela}/${totalParcelasVenda} do Titulo ID ${c.id.substring(0,8)}... espelhada na nuvem.`);
                    } catch (errLoopCR) {
                        logs.push(`[FALHA] Nao foi possivel espelhar a parcela do crediario ID ${c.id.substring(0,8)}: ${errLoopCR.message}`);
                    }
                }
            }

            logs.push(`[${new Date().toLocaleTimeString()}] ✅ Sincronizacao concluida com sucesso!`);
            return logs;

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - sincronizarTabelaManual FATAL]:", errGlobal.message);
            return [`[ERRO FATAL - ${new Date().toLocaleTimeString()}] Ocorreu um erro geral: ${errGlobal.message}`];
        }
    }

}

module.exports = new DatabaseManager();