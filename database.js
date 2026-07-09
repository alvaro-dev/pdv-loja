const { Client } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

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
            // HIGIENIZAÇÃO E CONVERSÃO ESTRITA
            const usuarioStr = String(usuario || '').trim();
            const senhaStr = String(senha || '').trim();
            const caixaIdStr = caixaId ? String(caixaId).trim() : null;
            
            console.log("[DB-LOGIN] Entrando na verificacao do banco...");

            // Verifica se já é o hash de 64 caracteres ou texto puro
            let senhaCriptografada = "";
            try {
                senhaCriptografada = (senhaStr.length === 64) 
                    ? senhaStr 
                    : this.gerarHashSenha(senhaStr);
            } catch (errHash) {
                console.error("[ERRO - realizarLogin (Geracao Hash)]: Falha ao processar a criptografia da senha:", errHash.message);
                throw new Error("Falha interna de seguranca ao processar credenciais.");
            }
            
            let operador = null;

            // 1. SE ESTIVER ONLINE, TENTA VALIDAR NO POSTGRESQL
            if (this.isOnline) {
                try {
                    console.log("[DB-LOGIN] Buscando usuario no PostgreSQL externo...");
                    const query = "SELECT id, usuario, nome, role, bloqueado, trocar_senha_prox_login FROM usuarios WHERE usuario = $1 AND senha = $2 AND usuario_pdv = 'S' AND deletado = false";
                    const resultado = await this.pgClient.query(query, [usuarioStr, senhaCriptografada]);
                    
                    if (resultado.rows.length > 0) {
                        operador = resultado.rows[0];
                        console.log("[DB-LOGIN] Localizado no Postgres com sucesso.");
                        
                        // Sincroniza na base local de contingência de forma assíncrona
                        this.sqliteDb.run(
                            `INSERT INTO usuarios_locais (id, usuario, nome, senha, role, bloqueado, usuario_pdv, trocar_senha_prox_login) 
                            VALUES (?, ?, ?, ?, ?, 'N', 'S', ?) 
                            ON CONFLICT(usuario) DO UPDATE SET nome=?, senha=?, role=?, trocar_senha_prox_login=?`,
                            [operador.id, operador.usuario, operador.nome, senhaCriptografada, operador.role, operador.trocar_senha_prox_login, operador.nome, senhaCriptografada, operador.role, operador.trocar_senha_prox_login],
                            (errSync) => {
                                if (errSync) {
                                    console.error("[ERRO SINC - realizarLogin]: Falha ao espelhar operador no SQLite local:", errSync.message);
                                }
                            }
                        );
                    } else {
                        console.log("[DB-LOGIN] Combinacao usuario/senha nao encontrada no Postgres.");
                    }
                } catch (err) {
                    console.error("[ERRO - realizarLogin (Postgres)]: Conexao perdida ou rejeitada pelo servidor remoto:", err.message);
                    this.isOnline = false;
                }
            }

            // 2. MODO OFFLINE DE CONTINGÊNCIA
            if (!operador) {
                try {
                    console.log("[DB-LOGIN] Buscando usuario na base de contingencia SQLite...");
                    operador = await new Promise((resolve, reject) => {
                        const query = "SELECT id, usuario, nome, role, bloqueado FROM usuarios_locais WHERE usuario = ? AND senha = ? AND usuario_pdv = 'S' AND deletado = 0";
                        this.sqliteDb.get(query, [usuarioStr, senhaCriptografada], (err, row) => {
                            if (err) reject(err);
                            else resolve(row || null);
                        });
                    });
                } catch (errSqlite) {
                    console.error("[ERRO - realizarLogin (SQLite)]: Erro critico ao consultar tabela usuarios_locais:", errSqlite.message);
                    throw new Error("Base de dados local inacessivel.");
                }
            }

            if (!operador) {
                console.log("[DB-LOGIN] Autenticacao recusada: Operador nao localizado nas bases.");
                return null;
            }

            // =====================================================================
            // EXCEÇÃO MASTER ANTECIPADA: Admins pulam qualquer trava de turno!
            // =====================================================================
            if (operador.role === 'admin' || operador.usuario === 'admin') {
                console.log(`[LOGIN] Administrador master "${operador.nome}" autenticado com sucesso.`);
                return operador;
            }

            // =====================================================================
            // 3. TRAVA A: Verifica se o terminal atual pertence a outro operador
            // =====================================================================
            if (caixaIdStr) {
                let caixaDono = null;
                
                if (this.isOnline) {
                    try {
                        console.log("[DB-LOGIN (TRAVA A)]: Verificando propriedade do caixa no Postgres...");
                        const queryCaixa = `
                            SELECT m.operador_abertura_id, o.nome AS dono_nome 
                            FROM movimentos_caixa m
                            JOIN usuarios o ON o.id = m.operador_abertura_id AND o.deletado = false
                            WHERE m.caixa_id = $1::uuid AND m.status = 'A' AND m.deletado = false
                            LIMIT 1
                        `;
                        const resCaixa = await this.pgClient.query(queryCaixa, [caixaIdStr]);
                        if (resCaixa.rows.length > 0) {
                            caixaDono = resCaixa.rows[0];
                        }
                    } catch (err) { 
                        console.error("[ERRO - realizarLogin (Trava A Postgres)]:", err.message);
                        this.isOnline = false; 
                    }
                }

                if (!this.isOnline) {
                    try {
                        console.log("[DB-LOGIN (TRAVA A)]: Verificando propriedade do caixa no SQLite local...");
                        caixaDono = await new Promise((resolve, reject) => {
                            this.sqliteDb.get(
                                `SELECT m.operador_abertura_id, 'Outro Operador (Offline)' AS dono_nome 
                                FROM movimentos_caixa_locais m 
                                WHERE m.caixa_id = ? AND m.status = 'A' AND m.deletado = 0`,
                                [caixaIdStr], (err, row) => {
                                    if (err) reject(err);
                                    else resolve(row || null);
                                }
                            );
                        });
                    } catch (errLiteCaixa) {
                        console.error("[ERRO - realizarLogin (Trava A SQLite)]:", errLiteCaixa.message);
                    }
                }

                if (caixaDono && caixaDono.operador_abertura_id !== operador.id) {
                    console.log(`[DB-LOGIN (REJEITADO)]: Bloqueio de terminal ativo por outro operador: "${caixaDono.dono_nome}"`);
                    throw new Error(`Este terminal ja possui um turno ativo do operador: "${caixaDono.dono_nome}". Finalize o turno atual antes de trocar de operador.`);
                }
            }

            // =====================================================================
            // 4. TRAVA B: Verifica se este operador comum já tem outro caixa aberto
            // =====================================================================
            let turnoAtivo = null;
            if (this.isOnline) {
                try {
                    console.log("[DB-LOGIN (TRAVA B)]: Verificando duplicidade de turno ativo no Postgres...");
                    const queryTrava = `
                        SELECT m.id, c.descricao AS caixa_nome, c.id AS cod_caixa
                        FROM movimentos_caixa m
                        JOIN caixas c ON c.id = m.caixa_id AND c.deletado = false
                        WHERE m.operador_abertura_id = $1 AND m.status = 'A' AND m.deletado = false
                        LIMIT 1
                    `;
                    const resTrava = await this.pgClient.query(queryTrava, [operador.id]);
                    if (resTrava.rows.length > 0) {
                        turnoAtivo = resTrava.rows[0];
                    }
                } catch (err) { 
                    console.error("[ERRO - realizarLogin (Trava B Postgres)]:", err.message);
                    this.isOnline = false; 
                }
            }

            if (!this.isOnline) {
                try {
                    console.log("[DB-LOGIN (TRAVA B)]: Verificando duplicidade de turno ativo no SQLite local...");
                    turnoAtivo = await new Promise((resolve, reject) => {
                        this.sqliteDb.get(
                            `SELECT m.id, 'outro terminal (Offline)' AS caixa_nome, c.id AS cod_caixa 
                            FROM movimentos_caixa_locais m 
                            JOIN caixas_locais c ON c.id = m.caixa_id AND c.deletado = 0
                            WHERE m.operador_abertura_id = ? AND m.status = 'A' AND m.deletado = 0`,
                            [operador.id], (err, row) => {
                                if (err) reject(err);
                                else resolve(row || null);
                            }
                        );
                    });
                } catch (errLiteTurno) {
                    console.error("[ERRO - realizarLogin (Trava B SQLite)]:", errLiteTurno.message);
                }
            }

            if (turnoAtivo) {
                if (String(turnoAtivo.cod_caixa).trim() !== caixaIdStr) {
                    console.log(`[DB-LOGIN (REJEITADO)]: Operador ja possui sessao ativa no terminal: "${turnoAtivo.caixa_nome}"`);
                    throw new Error(`Este operador ja possui um turno aberto no terminal: "${turnoAtivo.caixa_nome}". Encerre a outra sessao antes.`);
                }
            }

            console.log(`[DB-LOGIN (SUCESSO)]: Sessao autorizada para o operador comum "${operador.nome}".`);
            return operador;

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - realizarLogin FATAL]: Excecao nao tratada disparada no fluxo de faturamento:", errGlobal.message);
            throw errGlobal;
        }
    }

    // Atualize por completo o método obterDadosCaixa
    async obterDadosCaixa(caixaId) {
        try {
            console.log("[BANCO] Iniciando busca de dados do caixa...");
            let caixaLocal = null;

            try {
                // Consulta a base de dados local SQLite
                caixaLocal = await new Promise((resolve, reject) => {
                    const queryLocal = 'SELECT id, descricao, empresa_id, filial_id FROM caixas_locais WHERE id = ? AND deletado = 0';
                    this.sqliteDb.get(queryLocal, [caixaId], (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row || null);
                        }
                    });
                });
            } catch (errLite) {
                console.error("[ERRO - obterDadosCaixa (SQLite Local)]:", errLite.message);
                // Continua a execucao para tentar buscar no Postgres caso o SQLite falhe
            }

            if (caixaLocal && caixaLocal.empresa_id && caixaLocal.filial_id) {
                console.log("[LOCAL] IDs de Empresa e Filial carregados com sucesso do SQLite.");
                
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

            // Se nao encontrou localmente ou faltam dados de governanca, busca no Postgres
            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Buscando configuracoes de governanca do caixa no servidor remoto...");
                    // Nota: Usando cast explicito ::uuid conforme mapeamento rigido do banco de dados remoto
                    const queryPG = 'SELECT id, descricao, empresa_id, filial_id FROM caixas WHERE id = $1::uuid AND deletado = false';
                    const resultado = await this.pgClient.query(queryPG, [caixaId]);
                    
                    if (resultado.rows.length > 0) {
                        const caixa = resultado.rows[0];
                        
                        this.tenantEmpresaId = caixa.empresa_id;
                        this.tenantFilialId = caixa.filial_id;
                        
                        try {
                            // Salva ou atualiza os dados na tabela local de contingencia
                            await new Promise((resolve, reject) => {
                                this.sqliteDb.run(
                                    `INSERT INTO caixas_locais (id, descricao, empresa_id, filial_id, deletado) 
                                    VALUES (?, ?, ?, ?, 0) 
                                    ON CONFLICT(id) DO UPDATE SET descricao=?, empresa_id=?, filial_id=?`,
                                    [caixa.id, caixa.descricao, caixa.empresa_id, caixa.filial_id, caixa.descricao, caixa.empresa_id, caixa.filial_id],
                                    (errInsert) => {
                                        if (errInsert) reject(errInsert);
                                        else resolve();
                                    }
                                );
                            });
                            console.log("[POSTGRES] Dados de governanca baixados e salvos no SQLite Local.");
                        } catch (errSaveLite) {
                            console.error("[ERRO - obterDadosCaixa (Gravar Carga SQLite)]:", errSaveLite.message);
                        }
                        
                        return {
                            id: caixa.id,
                            descricao: caixa.descricao,
                            empresa_id: caixa.empresa_id,
                            filial_id: caixa.filial_id,
                            empresa_nome: "Grupo Alfa Varejo",
                            filial_nome: "Alfa Matriz"
                        };
                    } else {
                        console.log("[POSTGRES] Nao foi localizado nenhum registro para o ID de caixa informado.");
                    }
                } catch (err) {
                    console.error("[ERRO - obterDadosCaixa (Postgres Remote)]:", err.message);
                    this.isOnline = false;
                }
            }

            console.log("[BANCO] Finalizando metodo. Retornando ultima instancia conhecida do caixa local.");
            return caixaLocal; 

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - obterDadosCaixa FATAL]: Excecao nao tratada:", errGlobal.message);
            return null;
        }
    }

    // 🌟 MODIFICADO: Agora o método init recebe as credenciais lidas do JSON pelo Main
    // 🌟 ATUALIZADO: Livre de strings chumbadas e com validação rigorosa de parâmetros
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
                return; // Aborta a tentativa de conexão com o Postgres imediatamente
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

                // Carrega todas as regras de escopo na inicialização do sistema
                this.escoposCache = {};
                try {
                    const resEscopos = await this.pgClient.query("SELECT tabela_nome, escopo FROM tabelas_escopo");
                    resEscopos.rows.forEach(row => {
                        this.escoposCache[row.tabela_nome.toLowerCase()] = String(row.escopo).toUpperCase();
                    });
                    console.log("[DATABASE] Cache de regras de escopo carregado com sucesso:", this.escoposCache);
                } catch (errEscopo) {
                    console.error("[ERRO - init (query tabelas_escopo)]: Falha ao carregar tabela de escopos, usando padroes EXCLUSIVO:", errEscopo.message);
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
        
        // 2. Cria a tabela de caixas locais (Controle do Terminal)
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
        if (!this.pgClient) {
            console.log("[SYNC] Abortado: Sem cliente principal PostgreSQL configurado.");
            return { status: 'offline' };
        }

        let pgTemp = null;
        try {
            // Inicializa o cliente temporário isolado clonando as propriedades do principal
            pgTemp = new (require('pg').Client)({
                host: this.pgClient.connectionParameters?.host || this.pgClient.options?.host,
                database: this.pgClient.connectionParameters?.database || this.pgClient.options?.database,
                user: this.pgClient.connectionParameters?.user || this.pgClient.options?.user,
                password: this.pgClient.connectionParameters?.password || this.pgClient.options?.password,
                port: parseInt(this.pgClient.connectionParameters?.port || this.pgClient.options?.port) || 5432,
                connectionTimeoutMillis: 3000
            });
        } catch (errClient) {
            console.error("[ERRO - sincronizarOperadores (Instanciar pgTemp)]:", errClient.message);
            return { status: 'erro', mensagem: errClient.message };
        }
        
        try {
            console.log("[SYNC] Estabelecendo conexao temporaria para lote de operadores...");
            await pgTemp.connect();
            
            if (!this.tenantEmpresaId || !this.tenantFilialId) {
                console.log("[SYNC] Interrompido: Identificadores de governanca corporativa ausentes.");
                return { status: 'erro', mensagem: 'IDs de governanca ausentes no boot.' };
            }

            let ultimaAtualizacao = '1970-01-01 00:00:00';
            try {
                ultimaAtualizacao = await new Promise((resolve, reject) => {
                    this.sqliteDb.get(`SELECT COALESCE(MAX(data_alteracao), '1970-01-01 00:00:00') as ultima FROM usuarios_locais`, (err, row) => {
                        if (err) reject(err);
                        else resolve(row ? row.ultima : '1970-01-01 00:00:00');
                    });
                });
            } catch (errLiteGet) {
                console.error("[ERRO - sincronizarOperadores (Consultar MAX data_alteracao SQLite)]:", errLiteGet.message);
                throw errLiteGet;
            }

            console.log(`[SYNC-INCREMENTAL] Buscando operadores modificados no Postgres apos: ${ultimaAtualizacao}`);
            
            const queryPG = `
                SELECT DISTINCT
                    u.id, u.usuario, u.nome, u.senha, u.role, u.bloqueado, 
                    u.usuario_pdv, u.trocar_senha_prox_login,
                    TO_CHAR(u.data_alteracao, 'YYYY-MM-DD HH24:MI:SS') as data_alteracao
                FROM usuarios u
                JOIN usuarios_acessos a ON a.usuario_id = u.id
                WHERE u.usuario_pdv = 'S' 
                AND u.deletado = false
                AND a.empresa_id = $1 
                AND a.filial_id = $2
                AND DATE_TRUNC('second', u.data_alteracao) > $3::timestamp
            `;
            
            const resultado = await pgTemp.query(queryPG, [this.tenantEmpresaId, this.tenantFilialId, ultimaAtualizacao]);
            const operadoresNovos = resultado.rows;

            if (operadoresNovos.length === 0) {
                console.log("[SYNC-INCREMENTAL] Base de operadores locais ja esta 100% atualizada.");
                return { status: 'sucesso', total: 0 };
            }

            console.log(`[SYNC-INCREMENTAL] Injetando ${operadoresNovos.length} atualizacoes de operadores no SQLite...`);

            try {
                return await new Promise((resolve, reject) => {
                    this.sqliteDb.serialize(() => {
                        this.sqliteDb.run("BEGIN TRANSACTION");

                        const stmt = this.sqliteDb.prepare(`
                            INSERT INTO usuarios_locais (id, usuario, nome, senha, role, bloqueado, usuario_pdv, trocar_senha_prox_login, data_alteracao)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(usuario) DO UPDATE SET 
                                id = excluded.id, nome = excluded.nome, senha = excluded.senha, role = excluded.role, 
                                bloqueado = excluded.bloqueado, usuario_pdv = excluded.usuario_pdv, 
                                trocar_senha_prox_login = excluded.trocar_senha_prox_login, data_alteracao = excluded.data_alteracao
                        `);

                        for (const op of operadoresNovos) {
                            stmt.run([op.id, op.usuario, op.nome, op.senha, op.role, op.bloqueado, op.usuario_pdv, op.trocar_senha_prox_login, op.data_alteracao]);
                        }

                        stmt.finalize();
                        this.sqliteDb.run("COMMIT", (err) => {
                            if (err) {
                                reject(err);
                            } else {
                                console.log(`[SYNC-INCREMENTAL] Lote de ${operadoresNovos.length} operadores processado e comitado localmente.`);
                                resolve({ status: 'sucesso', total: operadoresNovos.length });
                            }
                        });
                    });
                });
            } catch (errLiteSave) {
                console.error("[ERRO - sincronizarOperadores (Gravar transacao SQLite)]:", errLiteSave.message);
                throw errLiteSave;
            }

        } catch (error) {
            console.error("[SYNC] Erro no lote incremental de operadores:", error.message);
            return { status: 'erro', mensagem: error.message };
        } finally {
            if (pgTemp) {
                try {
                    console.log("[SYNC] Encerrando conexao temporaria de operadores...");
                    await pgTemp.end();
                } catch (errEnd) {
                    console.error("[ERRO - sincronizarOperadores (Destruir pgTemp end)]:", errEnd.message);
                }
            }
        }
    }

    async sincronizarClientes() {
        if (!this.pgClient) {
            console.log("[SYNC-CLIENTES] Abortado: Sem cliente principal PostgreSQL configurado.");
            return { status: 'offline' };
        }

        let pgTemp = null;
        try {
            // Inicializa o cliente temporário isolado clonando as propriedades do principal
            pgTemp = new (require('pg').Client)({
                host: this.pgClient.connectionParameters?.host || this.pgClient.options?.host,
                database: this.pgClient.connectionParameters?.database || this.pgClient.options?.database,
                user: this.pgClient.connectionParameters?.user || this.pgClient.options?.user,
                password: this.pgClient.connectionParameters?.password || this.pgClient.options?.password,
                port: parseInt(this.pgClient.connectionParameters?.port || this.pgClient.options?.port) || 5432,
                connectionTimeoutMillis: 3000
            });
        } catch (errClient) {
            console.error("[ERRO - sincronizarClientes (Instanciar pgTemp)]:", errClient.message);
            return { status: 'erro', mensagem: errClient.message };
        }

        try {
            console.log("[SYNC-CLIENTES] Estabelecendo conexao temporaria para lote de clientes...");
            await pgTemp.connect();
            
            const escopoAtual = this.obterEscopoTabela('clientes');

            let ultimaAtualizacaoClientes = '1970-01-01 00:00:00';
            try {
                ultimaAtualizacaoClientes = await new Promise((resolve, reject) => {
                    this.sqliteDb.get(`SELECT COALESCE(MAX(data_alteracao), '1970-01-01 00:00:00') as ultima FROM clientes_locais`, (err, row) => {
                        if (err) reject(err);
                        else resolve(row ? row.ultima : '1970-01-01 00:00:00');
                    });
                });
            } catch (errLiteGet) {
                console.error("[ERRO - sincronizarClientes (Consultar MAX data_alteracao SQLite)]:", errLiteGet.message);
                throw errLiteGet;
            }

            console.log(`[SYNC-CLIENTES-INCREMENTAL] Verificando novos clientes apos: ${ultimaAtualizacaoClientes} | Escopo: ${escopoAtual}`);

            let queryPG = "";
            let parametrosPG = [];

            if (escopoAtual === 'COMPARTILHADO') {
                queryPG = `
                    SELECT 
                        c.id, c.empresa_id, c.filial_id, c.nome, c.cpf, c.bloqueado,
                        TO_CHAR(c.data_alteracao, 'YYYY-MM-DD HH24:MI:SS') as data_alteracao,
                        (COALESCE(c.limite_credito, 0) - COALESCE((SELECT SUM(saldo_restante) FROM contas_a_receber WHERE cliente_id = c.id AND status = 'P' AND deletado = false), 0)) as limite_restante
                    FROM clientes c
                    WHERE c.empresa_id = $1 AND c.filial_id IS NULL AND c.deletado = false AND DATE_TRUNC('second', c.data_alteracao) > $2::timestamp
                `;
                parametrosPG = [this.tenantEmpresaId, ultimaAtualizacaoClientes];
            } else {
                queryPG = `
                    SELECT 
                        c.id, c.empresa_id, c.filial_id, c.nome, c.cpf, c.bloqueado,
                        TO_CHAR(c.data_alteracao, 'YYYY-MM-DD HH24:MI:SS') as data_alteracao,
                        (COALESCE(c.limite_credito, 0) - COALESCE((SELECT SUM(saldo_restante) FROM contas_a_receber WHERE cliente_id = c.id AND status = 'P' AND deletado = false), 0)) as limite_restante
                    FROM clientes c
                    WHERE c.empresa_id = $1 AND c.filial_id = $2 AND c.deletado = false AND DATE_TRUNC('second', c.data_alteracao) > $3::timestamp
                `;
                parametrosPG = [this.tenantEmpresaId, this.tenantFilialId, ultimaAtualizacaoClientes];
            }

            const resultado = await pgTemp.query(queryPG, parametrosPG);
            const clientesNovos = resultado.rows;

            if (clientesNovos.length === 0) {
                console.log("[SYNC-CLIENTES-INCREMENTAL] Base de clientes locais ja esta 100% atualizada.");
                return { status: 'sucesso', total: 0 };
            }

            console.log(`[SYNC-CLIENTES-INCREMENTAL] Salvando ${clientesNovos.length} novos registros modificados no SQLite...`);

            try {
                return await new Promise((resolve, reject) => {
                    this.sqliteDb.serialize(() => {
                        this.sqliteDb.run("BEGIN TRANSACTION");

                        const stmt = this.sqliteDb.prepare(`
                            INSERT INTO clientes_locais (id, empresa_id, filial_id, nome, cpf, limite_credito, bloqueado, deletado, data_alteracao)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                            ON CONFLICT(id) DO UPDATE SET 
                                nome = excluded.nome, cpf = excluded.cpf, limite_credito = excluded.limite_credito, 
                                bloqueado = excluded.bloqueado, filial_id = excluded.filial_id, data_alteracao = excluded.data_alteracao
                        `);

                        for (const cli of clientesNovos) {
                            const saldoDisponivel = parseFloat(cli.limite_restante || 0);
                            stmt.run([cli.id, cli.empresa_id, cli.filial_id, cli.nome, cli.cpf, saldoDisponivel, cli.bloqueado, cli.data_alteracao]);
                        }

                        stmt.finalize();
                        this.sqliteDb.run("COMMIT", (err) => {
                            if (err) {
                                reject(err);
                            } else {
                                console.log(`[SYNC-CLIENTES-INCREMENTAL] Lote de ${clientesNovos.length} clientes gravado e comitado localmente.`);
                                resolve({ status: 'sucesso', total: clientesNovos.length });
                            }
                        });
                    });
                });
            } catch (errLiteSave) {
                console.error("[ERRO - sincronizarClientes (Gravar transacao SQLite)]:", errLiteSave.message);
                throw errLiteSave;
            }

        } catch (error) {
            console.error("[SYNC-CLIENTES] Erro fatal no lote incremental:", error.message);
            return { status: 'erro', mensagem: error.message };
        } finally {
            if (pgTemp) {
                try {
                    console.log("[SYNC-CLIENTES] Encerrando conexao temporaria de clientes...");
                    await pgTemp.end();
                } catch (errEnd) {
                    console.error("[ERRO - sincronizarClientes (Destruir pgTemp end)]:", errEnd.message);
                }
            }
        }
    }

    // Método auxiliar para buscar/filtrar os clientes locais na hora da venda (via autocomplete)
    async buscarClientesLocais(termoBusca) {
        try {
            console.log("[BANCO] Iniciando busca automatica de clientes locais...");

            return await new Promise((resolve, reject) => {
                const termo = `%${String(termoBusca || '').trim()}%`;
                const query = `
                    SELECT id, nome, cpf, limite_credito, bloqueado 
                    FROM clientes_locais 
                    WHERE (nome LIKE ? OR cpf LIKE ?) AND deletado = 0
                    LIMIT 10
                `;

                this.sqliteDb.all(query, [termo, termo], (err, rows) => {
                    if (err) {
                        console.error("[ERRO - buscarClientesLocais (Query SQLite)]:", err.message);
                        // Retorna um array vazio em caso de erro na consulta para nao travar o componente de autocomplete do front-end
                        resolve([]);
                    } else {
                        console.log(`[BANCO] Busca concluida. Encontrados ${rows ? rows.length : 0} clientes locais.`);
                        resolve(rows || []);
                    }
                });
            });

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - buscarClientesLocais FATAL]: Excecao nao tratada no fluxo de listagem:", errGlobal.message);
            return [];
        }
    }

    async verificarCaixaAberto(caixaId) {
        try {
            if (this.isOnline) {
                try {
                    console.log("[BANCO] Verificando status de abertura do caixa no PostgreSQL externo...");
                    // Aplicado o cast explicito ::uuid para garantir a compatibilidade com o tipo estrito do Postgres
                    const query = `SELECT id FROM movimentos_caixa WHERE caixa_id = $1::uuid AND status = 'A' AND deletado = false LIMIT 1`;
                    const res = await this.pgClient.query(query, [caixaId]);
                    return res.rows.length > 0;
                } catch (err) {
                    console.error("[ERRO - verificarCaixaAberto (Postgres Remote)]:", err.message);
                    this.isOnline = false;
                    // Nao interrompe o fluxo, deixa seguir para tentar ler a contingencia local abaixo
                }
            }
            
            console.log("[BANCO] Consultando status de abertura do caixa na base local SQLite...");
            return await new Promise((resolve, reject) => {
                const queryLocal = `SELECT id FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A' AND deletado = 0`;
                this.sqliteDb.get(queryLocal, [caixaId], (err, row) => {
                    if (err) {
                        console.error("[ERRO - verificarCaixaAberto (Query SQLite)]:", err.message);
                        // Resolve como false em vez de rejeitar para permitir que o fluxo do caixa trate de forma segura
                        resolve(false);
                    } else {
                        const statusAberto = !!row;
                        console.log(`[BANCO] Validacao concluida. Turno local aberto: ${statusAberto}`);
                        resolve(statusAberto);
                    }
                });
            });

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - verificarCaixaAberto FATAL]: Excecao nao tratada na checagem de turno:", errGlobal.message);
            return false;
        }
    }

    async abrirCaixa(caixaId, operadorId, valorAbertura) {
        try {
            console.log("[BANCO] Iniciando processo de abertura de turno de caixa...");
            
            let idMovimento = null;
            let dataAtual = null;

            try {
                idMovimento = crypto.randomUUID();
                dataAtual = obterDataHoraLocalANSI();
            } catch (errParams) {
                console.error("[ERRO - abrirCaixa (Geracao de Parametros)]:", errParams.message);
                throw new Error("Falha interna ao gerar metadados para abertura do turno.");
            }

            // CAPTURA DOS IDS GLOBAIS DE GOVERNANÇA EM MEMÓRIA
            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;

            if (this.isOnline) {
                try {
                    if (!empIdGlobal) {
                        throw new Error("Dados de governanca (Empresa ID) ausentes no escopo em memoria.");
                    }

                    // Busca a regra de escopo diretamente do cache global em memória
                    const escopoTurnos = this.obterEscopoTabela('movimentos_caixa');

                    // REGRA DE ESCOPO: Se movimentos_caixa for COMPARTILHADO, grava filial_id como NULL
                    const filialPgValor = (escopoTurnos === 'COMPARTILHADO') ? null : filIdGlobal;

                    console.log("[POSTGRES] Inserindo registro de abertura de turno no servidor remoto...");
                    
                    // Aplicado o cast explicito ::uuid nos parametros string do Postgres para evitar conflitos de tipagem
                    const queryPG = `
                        INSERT INTO movimentos_caixa (id, caixa_id, operador_abertura_id, data_abertura, valor_abertura, status, empresa_id, filial_id)
                        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamp, $5, $6, $7::uuid, $8::uuid)
                    `;
                    await this.pgClient.query(queryPG, [idMovimento, caixaId, operadorId, dataAtual, valorAbertura, 'A', empIdGlobal, filialPgValor]);
                    console.log("[BANCO] Turno de caixa aberto com sucesso no PostgreSQL.");
                } catch (err) {
                    console.error("[BANCO] Erro ao abrir no Postgres, mudando para contingencia offline:", err.message);
                    this.isOnline = false;
                }
            }

            const jaSincronizado = this.isOnline ? 1 : 0; // Identifica se subiu na hora pro Postgres

            console.log("[BANCO] Gravando registro de abertura de turno na base local SQLite...");
            return await new Promise((resolve, reject) => {
                const queryLite = `
                    INSERT INTO movimentos_caixa_locais (id, caixa_id, operador_abertura_id, data_abertura, valor_abertura, status, sincronizado) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;
                
                this.sqliteDb.run(
                    queryLite, 
                    [idMovimento, caixaId, operadorId, dataAtual, valorAbertura, 'A', jaSincronizado], 
                    (err) => {
                        if (err) {
                            console.error("[BANCO] Erro critico ao salvar abertura de turno no SQLite:", err.message);
                            reject(err);
                        } else {
                            console.log(`[BANCO] Turno de caixa aberto com sucesso no SQLite (Sincronizado: ${jaSincronizado}).`);
                            resolve({ status: 'sucesso', id: idMovimento });
                        }
                    }
                );
            });

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - abrirCaixa FATAL]: Excecao nao tratada na rotina de abertura de turno:", errGlobal.message);
            throw errGlobal;
        }
    }

    async registrarVenda(caixaId, operadorId, total, formaPagamento, origem, descricaoMovimento, bandeira = null, parcelas = 1, clienteId = '00000000-0000-0000-0000-000000000000') {
        try {
            console.log("[BANCO] Iniciando fluxo de registro de venda...");
            
            let idVenda = null;
            let dataAtual = null;

            try {
                idVenda = crypto.randomUUID();
                dataAtual = obterDataHoraLocalANSI();
            } catch (errParams) {
                console.error("[ERRO - registrarVenda (Geracao de Metadados)]:", errParams.message);
                throw new Error("Falha interna ao gerar identificadores para a venda.");
            }

            // TRAVA DE SEGURANÇA ANTICORRUPÇÃO: Garante que vendas em Crediário nunca salvem informações de bandeira de cartão
            if (formaPagamento === 'CR') {
                bandeira = null;
            }

            // CAPTURA DOS IDS GLOBAIS DE GOVERNANÇA EM MEMÓRIA
            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;

            // =====================================================================
            // TRAVA DE CRÉDITO HÍBRIDA: Checagem em Tempo Real na Rede (CR)
            // =====================================================================
            if (formaPagamento === 'CR') {
                if (clienteId === '00000000-0000-0000-0000-000000000000' || !clienteId) {
                    console.log("[BANCO (RECUSADO)]: Tentativa de crediario sem cliente nominal.");
                    throw new Error("Operacao Recusada: Vendas no Crediario exigem obrigatoriamente a identificacao de um Cliente nominal.");
                }

                let dadosCliente = null;
                try {
                    dadosCliente = await new Promise((resolve, reject) => {
                        this.sqliteDb.get(`SELECT nome, limite_credito FROM clientes_locais WHERE id = ?`, [clienteId], (err, row) => {
                            if (err) reject(err);
                            else resolve(row || null);
                        });
                    });
                } catch (errCliLite) {
                    console.error("[ERRO - registrarVenda (Consultar Cliente SQLite)]:", errCliLite.message);
                    throw new Error("Falha ao validar cadastro do cliente na base local.");
                }

                if (!dadosCliente) {
                    console.log(`[BANCO (RECUSADO)]: Cliente com ID ${clienteId} nao localizado no terminal.`);
                    throw new Error("Operacao Recusada: Cliente nao localizado na base de dados do terminal.");
                }

                const tetoCadastrado = parseFloat(dadosCliente.limite_credito || 0);
                const valorVendaAtual = parseFloat(total || 0);
                let totalDebitosAtuais = 0;

                if (this.isOnline) {
                    try {
                        console.log("[BANCO] Consultando debitos globais do cliente no Postgres...");
                        const querySaldoGlobal = `
                            SELECT COALESCE(SUM(saldo_restante), 0) as total_devido 
                            FROM contas_a_receber 
                            WHERE cliente_id = $1::uuid AND status = 'P' AND deletado = false
                        `;
                        const resSaldoGlobal = await this.pgClient.query(querySaldoGlobal, [clienteId]);
                        totalDebitosAtuais = parseFloat(resSaldoGlobal.rows[0].total_devido || 0);
                    } catch (err) {
                        console.error("[ERRO - registrarVenda (Saldo Global Postgres)]:", err.message);
                        this.isOnline = false;
                    }
                }

                if (!this.isOnline) {
                    try {
                        console.log("[BANCO] Consultando debitos locais do cliente no SQLite...");
                        totalDebitosAtuais = await new Promise((resolve, reject) => {
                            this.sqliteDb.get(
                                `SELECT COALESCE(SUM(valor_original), 0) as total_devido FROM contas_a_receber_locais WHERE cliente_id = ? AND status = 'P' AND deletado = 0`,
                                [clienteId],
                                (err, row) => {
                                    if (err) reject(err);
                                    else resolve(row ? (row.total_devido || 0) : 0);
                                }
                            );
                        });
                    } catch (errSaldoLite) {
                        console.error("[ERRO - registrarVenda (Saldo Local SQLite)]:", errSaldoLite.message);
                    }
                }

                const limiteDisponivel = tetoCadastrado - totalDebitosAtuais;

                if ((totalDebitosAtuais + valorVendaAtual) > tetoCadastrado) {
                    console.log(`[BANCO (RECUSADO)]: Limite insuficiente para o cliente ${dadosCliente.nome}`);
                    throw new Error(`Limite Insuficiente: O cliente "${dadosCliente.nome}" possui teto de R$ ${tetoCadastrado.toFixed(2)}. Ele ja possui R$ ${totalDebitosAtuais.toFixed(2)} em debitos em aberto na rede. Limite restante: R$ ${limiteDisponivel.toFixed(2)}. Esta nova compra totaliza R$ ${valorVendaAtual.toFixed(2)}.`);
                }
            }

            // 1. SALVA A VENDA NO SQLITE LOCAL PRIMEIRO
            try {
                console.log("[BANCO] Salvando cabecalho da venda no SQLite local...");
                await new Promise((resolve, reject) => {
                    const queryLite = `
                        INSERT INTO vendas_locais (id, caixa_id, operador_id, cliente_id, forma_pagamento, origem, total, descricao_movimento, data_venda, sincronizado, deletado, bandeira, parcelas) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
                    `;
                    this.sqliteDb.run(
                        queryLite, 
                        [idVenda, caixaId, operadorId, clienteId, formaPagamento, origem, total, descricaoMovimento, dataAtual, bandeira, parcelas], 
                        (err) => { if (err) reject(err); else resolve(); }
                    );
                });
            } catch (errSaleLite) {
                console.error("[ERRO CRITICO - registrarVenda (Gravar venda SQLite)]:", errSaleLite.message);
                throw new Error("Nao foi possivel registrar o cabecalho da venda localmente.");
            }

            // 2. GERAÇÃO DE PARCELAS NO CREDIÁRIO DESMEMBRADO (CR) NO SQLITE
            if (formaPagamento === 'CR' && total > 0) {
                try {
                    console.log(`[BANCO] Gerando ${parcelas} parcelas de crediario no SQLite...`);
                    const valorPorParcela = total / parcelas;
                    
                    for (let i = 1; i <= parcelas; i++) {
                        const idConta = crypto.randomUUID();
                        const dataVencimento = new Date();
                        dataVencimento.setDate(dataVencimento.getDate() + (30 * i));
                        const dataVencimentoStr = obterDataHoraLocalANSI(dataVencimento).split(' ')[0];

                        await new Promise((resolve, reject) => {
                            const queryCRLite = `
                                INSERT INTO contas_a_receber_locais (id, venda_id, cliente_id, data_vencimento, valor_original, status, sincronizado, deletado)
                                VALUES (?, ?, ?, ?, ?, 'P', 0, 0)
                            `;
                            this.sqliteDb.run(queryCRLite, [idConta, idVenda, clienteId, dataVencimentoStr, valorPorParcela], (err) => {
                                if (err) reject(err); else resolve();
                            });
                        });
                    }
                } catch (errCRLite) {
                    console.error("[ERRO CRITICO - registrarVenda (Gerar parcelas crediario SQLite)]:", errCRLite.message);
                    throw new Error("Falha interna ao desmembrar parcelas de crediario local.");
                }
            }

            // GERAÇÃO DE PARCELAS SE FOR CARTÃO (CC) NO SQLITE LOCAL
            if (formaPagamento === 'CC' && total > 0) {
                try {
                    console.log(`[BANCO] Gerando ${parcelas} parcelas de recebivel de cartao no SQLite...`);
                    const valorPorParcela = total / parcelas;
                    for (let i = 1; i <= parcelas; i++) {
                        const idRecebivel = crypto.randomUUID();
                        const dataPrevista = new Date();
                        dataPrevista.setDate(dataPrevista.getDate() + (30 * i));
                        const dataPrevistaStr = obterDataHoraLocalANSI(dataPrevista);

                        await new Promise((resolve, reject) => {
                            this.sqliteDb.run(`
                                INSERT INTO recebiveis_cartao_locais (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, sincronizado, deletado)
                                VALUES (?, ?, ?, ?, ?, ?, 'P', 0, 0)
                            `, [idRecebivel, idVenda, caixaId, i, valorPorParcela, dataPrevistaStr], (err) => {
                                if (err) reject(err); else resolve();
                            });
                        });
                    }
                } catch (errCCLite) {
                    console.error("[ERRO CRITICO - registrarVenda (Gerar recebiveis cartao SQLite)]:", errCCLite.message);
                    throw new Error("Falha interna ao desmembrar parcelas de cartao local.");
                }
            }

            // 3. REPLICAÇÃO EM TEMPO REAL PRO POSTGRESQL (SE ONLINE)
            if (this.isOnline) {
                try {
                    if (!empIdGlobal) throw new Error("Dados de governanca (Empresa ID) ausentes no escopo.");

                    const escopoVendas = this.obterEscopoTabela('vendas');
                    const filialPgValor = (escopoVendas === 'COMPARTILHADO') ? null : filIdGlobal;

                    console.log("[POSTGRES] Replicando venda pai no servidor remoto...");
                    
                    // Aplicado cast explicito nos campos UUID e TIMESTAMP para adequacao estrita
                    const queryPG = `
                        INSERT INTO vendas (id, caixa_id, operador_id, cliente_id, forma_pagamento,起源, total, descricao_movimento, data_venda, bandeira, parcelas, empresa_id, filial_id) 
                        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::timestamp, $10, $11, $12::uuid, $13::uuid)
                    `;
                    await this.pgClient.query(queryPG, [idVenda, caixaId, operadorId, clienteId, formaPagamento, origem, total, descricaoMovimento, dataAtual, bandeira, parcelas, empIdGlobal, filialPgValor]);
                    
                    // UPLOAD DAS MÚLTIPLAS PARCELAS DE CREDIÁRIO PRO POSTGRES
                    if (formaPagamento === 'CR') {
                        console.log("[POSTGRES] Replicando parcelas de crediario no servidor remoto...");
                        const contasLocais = await new Promise((resolve) => {
                            this.sqliteDb.all(`SELECT * FROM contas_a_receber_locais WHERE venda_id = ?`, [idVenda], (err, rows) => resolve(rows || []));
                        });
                        
                        const escopoCR = this.obterEscopoTabela('contas_a_receber');
                        const filialCRPgValor = (escopoCR === 'COMPARTILHADO') ? null : filIdGlobal;

                        let nrParcela = 1;
                        for (const conta of contasLocais) {
                            const queryCRPostgres = `
                                INSERT INTO contas_a_receber (id, empresa_id, filial_id, venda_id, cliente_id, parcela_numero, total_parcelas, data_emissao, data_vencimento, valor_original, valor_juros, valor_multa, valor_pago, saldo_restante, status, deletado)
                                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::timestamp, $9::date, $10, 0.00, 0.00, 0.00, $11, 'P', false)
                            `;
                            
                            await this.pgClient.query(queryCRPostgres, [
                                conta.id, empIdGlobal, filialCRPgValor, idVenda, clienteId,
                                nrParcela, parcelas, dataAtual, conta.data_vencimento, conta.valor_original, conta.valor_original
                            ]);

                            this.sqliteDb.run(`UPDATE contas_a_receber_locais SET sincronizado = 1 WHERE id = ?`, [conta.id]);
                            nrParcela++;
                        }
                    }

                    if (formaPagamento === 'CC') {
                        console.log("[POSTGRES] Replicando parcelas de cartao no servidor remoto...");
                        const escopoRecebiveis = this.obterEscopoTabela('recebiveis_cartao');
                        const filialRecPgValor = (escopoRecebiveis === 'COMPARTILHADO') ? null : filIdGlobal;

                        const recebiveis = await new Promise((resolve) => {
                            this.sqliteDb.all(`SELECT * FROM recebiveis_cartao_locais WHERE venda_id = ?`, [idVenda], (err, rows) => resolve(rows || []));
                        });
                        for (const rec of recebiveis) {
                            await this.pgClient.query(`INSERT INTO recebiveis_cartao (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, empresa_id, filial_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamp, 'P', $7::uuid, $8::uuid)`, [rec.id, idVenda, caixaId, rec.parcela_numero, rec.valor_parcela, rec.data_prevista_recebimento, empIdGlobal, filialRecPgValor]);
                            this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET sincronizado = 1 WHERE id = ?`, [rec.id]);
                        }
                    }

                    this.sqliteDb.run(`UPDATE vendas_locais SET sincronizado = 1 WHERE id = ?`, [idVenda]);
                    console.log("[BANCO] Fluxo completo de faturamento online concluido com exito.");
                    return { status: 'sucesso', modo: 'ONLINE', id: idVenda };
                    
                } catch (err) {
                    console.error("[BANCO] Erro ao espelhar transacao no Postgres, operando em contingencia:", err.message);
                    this.isOnline = false;
                }
            }

            console.log("[BANCO] Fluxo concluido em modo de contingencia offline.");
            return { status: 'sucesso', modo: 'OFFLINE (SQLite)', id: idVenda };

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - registrarVenda FATAL]: Excecao nao tratada no pipeline de vendas:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async verificarConexaoPostgres() {
        if (!this.pgClient) return;
        try {
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
            if (!this.isOnline) {
                console.log("[SYNC] Execucao abortada: O sistema encontra-se em modo offline.");
                return { status: 'offline' };
            }

            // VALIDACAO DE SEGURANCA: Garante que as variaveis globais de governanca em memoria estejam disponiveis
            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;

            if (!empIdGlobal) {
                console.error("[SYNC] Abortado: IDs de governanca (Empresa) nao carregados no escopo global.");
                return { status: 'erro', mensagem: 'Governança ausente em memoria.' };
            }

            console.log("[SYNC] Buscando vendas pendentes de sincronizacao no SQLite local...");
            return await new Promise((resolve) => {
                this.sqliteDb.all(`SELECT * FROM vendas_locais WHERE sincronizado = 0`, [], async (err, vendasPendentes) => {
                    if (err) {
                        console.error("[SYNC] Erro ao ler registros da tabela vendas_locais no SQLite:", err.message);
                        return resolve({ status: 'erro' });
                    }

                    if (vendasPendentes.length === 0) {
                        console.log("[SYNC] Nao foram encontradas vendas pendentes locais para upload.");
                        return resolve({ status: 'limpo', total: 0 }); 
                    }

                    console.log(`[SYNC] Sincronizando ${vendasPendentes.length} atualizacoes de forma otimizada com a nuvem...`);

                    try {
                        // Busca direto do cache em memória instantaneamente
                        const escopoVendas = this.obterEscopoTabela('vendas');
                        const filialPgValor = (escopoVendas === 'COMPARTILHADO') ? null : filIdGlobal;

                        for (const venda of vendasPendentes) {
                            const estaDeletadoPG = (venda.deletado === 1);

                            // Aplicados os casts explicitos ::uuid e ::timestamp para blindagem do motor do Postgres
                            const queryVendaPG = `
                                INSERT INTO vendas (id, caixa_id, operador_id, cliente_id, forma_pagamento, origem, total, descricao_movimento, data_venda, deletado, bandeira, parcelas, empresa_id, filial_id)
                                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::timestamp, $10, $11, $12, $13::uuid, $14::uuid)
                                ON CONFLICT (id) DO UPDATE SET deletado = excluded.deletado
                            `;
                            
                            const clientePgValor = (venda.cliente_id === 'CONSUMIDOR-FINAL' || !venda.cliente_id)
                                ? '00000000-0000-0000-0000-000000000000' 
                                : venda.cliente_id;

                            // 1. Faz o upload da Venda Pai no Postgres utilizando as variáveis em memória
                            await this.pgClient.query(queryVendaPG, [
                                venda.id, venda.caixa_id, venda.operador_id, clientePgValor, 
                                venda.forma_pagamento, venda.origem, venda.total, venda.descricao_movimento, 
                                venda.data_venda, estaDeletadoPG, venda.bandeira, venda.parcelas, 
                                empIdGlobal, filialPgValor
                            ]);
                            
                            // =====================================================================
                            // Sincronizacao Dinamica de Recebiveis (CC)
                            // =====================================================================
                            if (venda.forma_pagamento === 'CC') {
                                try {
                                    const escopoRecebiveis = this.obterEscopoTabela('recebiveis_cartao');
                                    const filialRecPgValor = (escopoRecebiveis === 'COMPARTILHADO') ? null : filIdGlobal;

                                    const recebiveis = await new Promise((resolveRec, rejectRec) => {
                                        this.sqliteDb.all(`SELECT * FROM recebiveis_cartao_locais WHERE venda_id = ?`, [venda.id], (errRec, rows) => {
                                            if (errRec) rejectRec(errRec);
                                            else resolveRec(rows || []);
                                        });
                                    });

                                    for (const r of recebiveis) {
                                        const queryRecPG = `
                                            INSERT INTO recebiveis_cartao (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, deletado, empresa_id, filial_id)
                                            VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamp, $7, $8, $9::uuid, $10::uuid)
                                            ON CONFLICT (id) DO UPDATE SET status = excluded.status, deletado = excluded.deletado
                                        `;
                                        
                                        await this.pgClient.query(queryRecPG, [r.id, venda.id, venda.caixa_id, r.parcela_numero, r.valor_parcela, r.data_prevista_recebimento, r.status, r.deletado === 1, empIdGlobal, filialRecPgValor]);
                                        
                                        this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET sincronizado = 1 WHERE id = ?`, [r.id]);
                                    }
                                } catch (errCC) {
                                    console.error(`[ERRO - SYNC (Lote Recebiveis Venda ID ${venda.id})]:`, errCC.message);
                                    throw errCC; // Rejeita para interromper o laco e marcar falha de rede
                                }
                            }

                            // =====================================================================
                            // Sincronizacao de Multiplas Parcelas do Crediario (CR)
                            // =====================================================================
                            if (venda.forma_pagamento === 'CR') {
                                try {
                                    const contasLocais = await new Promise((resolveCR, rejectCR) => {
                                        this.sqliteDb.all(`SELECT * FROM contas_a_receber_locais WHERE venda_id = ? AND sincronizado = 0`, [venda.id], (errCR, rows) => {
                                            if (errCR) rejectCR(errCR);
                                            else resolveCR(rows || []);
                                        });
                                    });

                                    if (contasLocais.length > 0) {
                                        const escopoCR = this.obterEscopoTabela('contas_a_receber');
                                        const filialCRPgValor = (escopoCR === 'COMPARTILHADO') ? null : filIdGlobal;

                                        let nrP = 1;
                                        for (const conta of contasLocais) {
                                            const queryCRPostgres = `
                                                INSERT INTO contas_a_receber (id, empresa_id, filial_id, venda_id, cliente_id, parcela_numero, total_parcelas, data_emissao, data_vencimento, valor_original, valor_juros, valor_multa, valor_pago, saldo_restante, status, deletado)
                                                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::timestamp, $9::date, $10, 0.00, 0.00, 0.00, $11, 'P', false)
                                                ON CONFLICT (id) DO UPDATE SET status = excluded.status
                                            `;
                                            
                                            await this.pgClient.query(queryCRPostgres, [
                                                conta.id, empIdGlobal, filialCRPgValor, venda.id, venda.cliente_id,
                                                nrP, venda.parcelas, venda.data_venda, conta.data_vencimento, conta.valor_original, conta.valor_original
                                            ]);

                                            this.sqliteDb.run(`UPDATE contas_a_receber_locais SET sincronizado = 1 WHERE id = ?`, [conta.id]);
                                            nrP++;
                                        }
                                    }
                                } catch (errCR) {
                                    console.error(`[ERRO - SYNC (Lote Crediario Venda ID ${venda.id})]:`, errCR.message);
                                    throw errCR;
                                }
                            }

                            // 2. Com a venda pai e todas as parcelas seguras na nuvem, marca a venda local como sincronizada
                            this.sqliteDb.run(`UPDATE vendas_locais SET sincronizado = 1 WHERE id = ?`, [venda.id]);
                        }

                        console.log("[SYNC] Sincronizacao e auditoria concluidas com sucesso!");
                        resolve({ status: 'sucesso', total: vendasPendentes.length });

                    } catch (error) {
                        console.error("[SYNC] Erro detectado no lote de envio para a nuvem:", error.message);
                        this.isOnline = false;
                        resolve({ status: 'erro_rede' });
                    }
                });
            });

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - sincronizarVendasPendentes FATAL]: Excecao nao tratada no background worker:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async obterResumoTurnoAtual(caixaId) {
        try {
            console.log("[BANCO] Iniciando levantamento do resumo do turno atual...");
            let movimento = null;
            
            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Buscando metadados do turno ativo no servidor remoto...");
                    // Aplicado cast explicito ::uuid para alcancar compatibilidade estrita com a coluna do Postgres
                    const queryMov = `SELECT id, valor_abertura, data_abertura FROM movimentos_caixa WHERE caixa_id = $1::uuid AND status = 'A' AND deletado = false LIMIT 1`;
                    const res = await this.pgClient.query(queryMov, [caixaId]);
                    if (res.rows.length > 0) {
                        movimento = res.rows[0];
                    }
                } catch (err) { 
                    console.error("[ERRO - obterResumoTurnoAtual (Buscar Movimento Postgres)]:", err.message);
                    this.isOnline = false; 
                }
            }
            
            if (!movimento) {
                try {
                    console.log("[BANCO] Buscando metadados do turno ativo no SQLite local...");
                    movimento = await new Promise((resolve, reject) => {
                        const queryLiteMov = `SELECT id, valor_abertura, data_abertura FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A' AND deletado = 0`;
                        this.sqliteDb.get(queryLiteMov, [caixaId], (err, row) => {
                            if (err) reject(err);
                            else resolve(row || null);
                        });
                    });
                } catch (errLiteMov) {
                    console.error("[ERRO - obterResumoTurnoAtual (Buscar Movimento SQLite)]:", errLiteMov.message);
                }
            }

            if (!movimento) {
                console.log("[BANCO] Resumo abortado: Nenhum turno aberto localizado para este caixa.");
                return { status: 'erro', mensagem: 'Nenhum turno aberto encontrado para este caixa.' };
            }

            const dataAberturaTurno = movimento.data_abertura;
            let vendas = [];

            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Coletando lote de vendas do turno no servidor remoto...");
                    // Aplicados os casts explicitos ::uuid e ::timestamp para correspondencia de tipos no Postgres
                    const queryPG = `
                        SELECT origem, total, forma_pagamento FROM vendas 
                        WHERE caixa_id = $1::uuid AND data_venda >= $2::timestamp AND deletado = false
                    `;
                    const res = await this.pgClient.query(queryPG, [caixaId, dataAberturaTurno]);
                    vendas = res.rows;
                } catch (err) { 
                    console.error("[ERRO - obterResumoTurnoAtual (Listar Vendas Postgres)]:", err.message);
                    this.isOnline = false; 
                }
            }
            
            if (!this.isOnline) {
                try {
                    console.log("[BANCO] Coletando lote de vendas do turno no SQLite local...");
                    vendas = await new Promise((resolve, reject) => {
                        const queryLite = `
                            SELECT origem, total, forma_pagamento FROM vendas_locais 
                            WHERE caixa_id = ? AND data_venda >= ? AND deletado = 0
                        `;
                        this.sqliteDb.all(queryLite, [caixaId, dataAberturaTurno], (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
                        });
                    });
                } catch (errLiteSales) {
                    console.error("[ERRO - obterResumoTurnoAtual (Listar Vendas SQLite)]:", errLiteSales.message);
                    vendas = []; // Força inicialização em caso de falha física de leitura
                }
            }

            console.log(`[BANCO] Processando somatorio financeiro sobre ${vendas.length} lancamentos localizados...`);
            let totalEntradas = 0;
            let totalSaidas = 0;

            const detalheFormas = {
                DN: { nome: 'Dinheiro', entradas: 0, saidas: 0 },
                CC: { nome: 'Cartao de Credito', entradas: 0, saidas: 0 },
                CD: { nome: 'Cartao de Debito', entradas: 0, saidas: 0 },
                PX: { nome: 'Pix', entradas: 0, saidas: 0 }
            };

            try {
                vendas.forEach(v => {
                    const valor = parseFloat(v.total || 0);
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
            } catch (errCalc) {
                console.error("[ERRO - obterResumoTurnoAtual (Iteracao/Calculo de Valores)]:", errCalc.message);
                throw new Error("Falha interna ao totalizar valores monetarios do turno.");
            }

            const fundoInicial = parseFloat(movimento.valor_abertura || 0);
            const saldoFinal = fundoInicial + totalEntradas - totalSaidas;

            console.log("[BANCO] Resumo financeiro do turno consolidado com sucesso.");
            return {
                movimentoId: movimento.id,
                fundoInicial,
                totalEntradas,
                totalSaidas,
                saldoFinal,
                detalheFormas: Object.values(detalheFormas)
            };

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - obterResumoTurnoAtual FATAL]: Excecao nao tratada:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async fecharCaixa(movimentoId, operadorFechamentoId, valorFechamento, valorContado, diferenca) {
        try {
            console.log("[BANCO] Iniciando processo de fechamento de turno de caixa...");
            
            let dataAtual = null;
            try {
                dataAtual = obterDataHoraLocalANSI();
            } catch (errParams) {
                console.error("[ERRO - fecharCaixa (Obter Data Local)]:", errParams.message);
                throw new Error("Falha interna ao gerar data de fechamento para o turno.");
            }

            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Atualizando status do turno para fechado no servidor remoto...");
                    
                    // Aplicados os casts explicitos ::timestamp e ::uuid para evitar incompatibilidades de tipo no Postgres
                    const queryPG = `
                        UPDATE movimentos_caixa 
                        SET status = 'F', data_fechamento = $1::timestamp, operador_fechamento_id = $2::uuid, 
                            valor_fechamento = $3, valor_contado = $4, diferenca = $5
                        WHERE id = $6::uuid
                    `;
                    await this.pgClient.query(queryPG, [dataAtual, operadorFechamentoId, valorFechamento, valorContado, diferenca, movimentoId]);
                    console.log("[BANCO] Turno de caixa encerrado com sucesso no PostgreSQL.");
                } catch (err) { 
                    console.error("[ERRO - fecharCaixa (Postgres Remote)]:", err.message);
                    this.isOnline = false; 
                }
            }

            const jaSincronizadoFec = this.isOnline ? 1 : 0; // Se fechou direto na nuvem, marca como sincronizado local

            console.log("[BANCO] Atualizando status do turno na base local SQLite...");
            return await new Promise((resolve, reject) => {
                const queryLite = `
                    UPDATE movimentos_caixa_locais 
                    SET status = 'F', data_fechamento = ?, operador_fechamento_id = ?, 
                        valor_fechamento = ?, valor_contado = ?, diferenca = ?, sincronizado = ?
                    WHERE id = ?
                `;
                this.sqliteDb.run(queryLite, [dataAtual, operadorFechamentoId, valorFechamento, valorContado, diferenca, jaSincronizadoFec, movimentoId], (err) => {
                    if (err) {
                        console.error("[ERRO - fecharCaixa (Query SQLite)]:", err.message);
                        reject(err);
                    } else {
                        console.log(`[BANCO] Turno de caixa fechado localmente com sucesso (Sincronizado: ${jaSincronizadoFec}).`);
                        resolve({ status: 'sucesso' });
                    }
                });
            });

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - fecharCaixa FATAL]: Excecao nao tratada na rotina de fechamento de turno:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async excluirLancamento(vendaId) {
        try {
            console.log("[BANCO] Iniciando processo de exclusao de lancamento...");

            // 1. Se estiver online, atualiza na nuvem
            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Executando soft delete da venda e recebiveis no servidor remoto...");
                    
                    // Marca a venda como deletada no Postgres utilizando cast explicito ::uuid
                    const queryPG = `UPDATE vendas SET deletado = true WHERE id = $1::uuid`;
                    await this.pgClient.query(queryPG, [vendaId]);
                    
                    // Marca as parcelas como deletadas no Postgres utilizando cast explicito ::uuid
                    await this.pgClient.query(`UPDATE recebiveis_cartao SET deletado = true WHERE venda_id = $1::uuid`, [vendaId]);

                    try {
                        console.log("[BANCO] Replicando marcacao de exclusao sincronizada no SQLite local...");
                        // Se tudo subiu para a nuvem com sucesso, atualiza o SQLite local como sincronizado
                        await new Promise((resolve, reject) => {
                            this.sqliteDb.serialize(() => {
                                this.sqliteDb.run("BEGIN TRANSACTION");
                                this.sqliteDb.run(`UPDATE vendas_locais SET deletado = 1, sincronizado = 1 WHERE id = ?`, [vendaId]);
                                this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET deletado = 1, sincronizado = 1 WHERE venda_id = ?`, [vendaId]);
                                this.sqliteDb.run("COMMIT", (err) => {
                                    if (err) reject(err);
                                    else resolve();
                                });
                            });
                        });
                    } catch (errLiteSync) {
                        console.error("[ERRO - excluirLancamento (Atualizar Status Sync SQLite)]:", errLiteSync.message);
                        // Nao interrompe o fluxo principal de retorno pois o dado ja está salvo na nuvem
                    }
                    
                    console.log(`[BANCO] Lancamento ${vendaId} e seus recebiveis marcados como deletados no Postgres e SQLite.`);
                    return { status: 'sucesso' };

                } catch (err) {
                    console.error("[BANCO] Erro ao excluir no Postgres, mudando para contingencia local:", err.message);
                    this.isOnline = false; // Cai para o modo offline para concluir a operação localmente
                }
            }

            // 2. Modo de contingência offline (Se a internet cair ou o bloco acima falhar)
            console.log("[BANCO] Gravando marcacao de exclusao pendente de sincronizacao no SQLite local...");
            return await new Promise((resolve, reject) => {
                this.sqliteDb.serialize(() => {
                    this.sqliteDb.run("BEGIN TRANSACTION");

                    this.sqliteDb.run(`UPDATE vendas_locais SET deletado = 1, sincronizado = 0 WHERE id = ?`, [vendaId]);
                    this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET deletado = 1, sincronizado = 0 WHERE venda_id = ?`, [vendaId]);

                    this.sqliteDb.run("COMMIT", (err) => {
                        if (err) {
                            console.error("[BANCO] Erro ao atualizar exclusao pendente no SQLite:", err.message);
                            this.sqliteDb.run("ROLLBACK", () => {
                                reject(err);
                            });
                        } else {
                            console.log(`[BANCO] Lancamento ${vendaId} e recebiveis marcados para exclusao local (Pendente de Sync).`);
                            resolve({ status: 'sucesso' });
                        }
                    });
                });
            });

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - excluirLancamento FATAL]: Excecao nao tratada na rotina de exclusao:", errGlobal.message);
            return { status: 'erro', mensagem: errGlobal.message };
        }
    }

    async listarVendasTurnoAtual(caixaId) {
        try {
            console.log("[BANCO] Iniciando listagem de vendas do turno atual...");
            let movimiento = null;

            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Buscando data de abertura do turno ativo...");
                    // Cast apenas no parametro string $1 para a coluna UUID do caixa
                    const res = await this.pgClient.query(`SELECT data_abertura FROM movimentos_caixa WHERE caixa_id = $1::uuid AND status = 'A' AND deletado = false LIMIT 1`, [caixaId]);
                    if (res.rows.length > 0) {
                        movimento = res.rows[0];
                    }
                } catch (err) { 
                    console.error("[ERRO CRITICO POSTGRES - BUSCAR ABERTURA TURNO]:", err.message);
                    this.isOnline = false; 
                }
            }

            if (!movimiento) {
                try {
                    console.log("[BANCO] Buscando data de abertura do turno ativo no SQLite local...");
                    movimento = await new Promise((resolve, reject) => {
                        this.sqliteDb.get(`SELECT data_abertura FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A'  AND deletado = 0`, [caixaId], (err, row) => {
                            if (err) reject(err);
                            else resolve(row || null);
                        });
                    });
                } catch (errLiteMov) {
                    console.error("[ERRO - listarVendasTurnoAtual (Buscar Turno SQLite)]:", errLiteMov.message);
                }
            }

            if (!movimiento) {
                console.log("[BANCO] Nenhuma venda listada: Turno aberto nao localizado para este caixa.");
                return [];
            }

            if (this.isOnline) {
                try {
                    console.log("[POSTGRES] Consultando historico de vendas do turno no servidor remoto...");
                    // QUERY LIMPA: Como cliente_id agora e UUID no Postgres, o JOIN com c.id funciona direto!
                    const queryPostgresTurno = `
                        SELECT 
                            v.id, v.origem, v.total, v.forma_pagamento, v.descricao_movimento, v.bandeira, v.parcelas, 
                            COALESCE(c.nome, 'CONSUMIDOR FINAL') as cliente_nome 
                        FROM vendas v 
                        LEFT JOIN clientes c ON c.id = v.cliente_id 
                        WHERE v.caixa_id = $1::uuid 
                        AND v.data_venda >= $2::timestamp 
                        AND v.deletado = false 
                        ORDER BY v.data_venda DESC
                    `;
                    const res = await this.pgClient.query(queryPostgresTurno, [caixaId, movimiento.data_abertura]);
                    return res.rows;
                } catch (err) { 
                    console.error("[ERRO CRITICO POSTGRES - LISTAR VENDAS TURNO]:", err.message);
                    this.isOnline = false; 
                }
            }
            
            console.log("[BANCO] Consultando historico de vendas do turno no SQLite local...");
            return await new Promise((resolve) => {
                this.sqliteDb.all(`
                    SELECT 
                        v.id, v.origem, v.total, v.forma_pagamento, v.descricao_movimento, v.bandeira, v.parcelas, 
                        COALESCE(c.nome, 'CONSUMIDOR FINAL') as cliente_nome 
                    FROM vendas_locais v 
                    LEFT JOIN clientes_locais c ON c.id = v.cliente_id 
                    WHERE v.caixa_id = ? AND v.data_venda >= ? AND v.deletado = 0 
                    ORDER BY v.data_venda DESC
                `, [caixaId, movimiento.data_abertura], (err, rows) => {
                    if (err) {
                        console.error("[ERRO - listarVendasTurnoAtual (Listar Vendas SQLite)]:", err.message);
                        resolve([]);
                    } else {
                        console.log(`[BANCO] Listagem local concluida. ${rows ? rows.length : 0} registros retornados.`);
                        resolve(rows || []);
                    }
                });
            });

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - listarVendasTurnoAtual FATAL]: Excecao nao tratada na listagem do grid:", errGlobal.message);
            return [];
        }
    }

    async obterHistoricoTurnos(dataInicio, dataFim) {
        if (this.isOnline) {
            try {
                let queryPG = `
                    SELECT 
                        m.id, 
                        m.caixa_id, 
                        c.descricao AS caixa_nome, 
                        o.nome AS operador_nome, 
                        m.data_abertura, 
                        m.data_fechamento, 
                        m.valor_abertura, 
                        m.valor_fechamento,
                        m.valor_contado,
                        m.diferenca
                    FROM movimentos_caixa m
                    JOIN caixas c ON c.id = m.caixa_id AND c.deletado = false
                    JOIN usuarios o ON o.id = m.operador_abertura_id AND o.deletado = false
                    WHERE m.status = 'F' AND m.deletado = false
                `;

                const parametros = [];

                // 🌟 Filtro Dinâmico: Se o usuário enviou as datas, adiciona a trava de período timestamp
                if (dataInicio && dataFim) {
                    // Força abranger desde o primeiro minuto do dia inicial até o último minuto do dia final
                    parametros.push(`${dataInicio} 00:00:00`);
                    parametros.push(`${dataFim} 23:59:59`);
                    queryPG += ` AND m.data_fechamento >= $1::timestamp AND m.data_fechamento <= $2::timestamp`;
                }

                queryPG += ` ORDER BY m.data_fechamento DESC LIMIT 100`;

                const res = await this.pgClient.query(queryPG, parametros);
                return res.rows;
            } catch (err) {
                this.isOnline = false;
                throw new Error("Conexão perdida com o servidor Linux PostgreSQL.");
            }
        }
        
        throw new Error("O sistema encontra-se em modo de contingência offline.");
    }

    async obterVendasPorPeriodo(caixaId, dataAbertura, dataFechamento) {
        // Função para extrair o carimbo de data/hora regional exato sem converter fuso horário
        const extrairTimestampLocal = (dataStr) => {
            if (!dataStr || dataStr === 'N/A' || dataStr === 'Finalizado') return null;
            
            try {
                // Se já vier no formato BR "dd/mm/aaaa, hh:mm:ss", converte direto
                if (dataStr.includes(',')) {
                    const [data, hora] = dataStr.split(', ');
                    const [dia, mes, ano] = data.split('/');
                    return `${ano}-${mes}-${dia} ${hora}`;
                }

                // Cria o objeto de data baseado na string por extenso do JavaScript
                const d = new Date(dataStr);
                if (isNaN(d.getTime())) return null;

                // Extrai os dados locais da máquina (fuso regional correto)
                const ano = d.getFullYear();
                const mes = String(d.getMonth() + 1).padStart(2, '0');
                const dia = String(d.getDate()).padStart(2, '0');
                const hora = String(d.getHours()).padStart(2, '0');
                const minuto = String(d.getMinutes()).padStart(2, '0');
                const segundo = String(d.getSeconds()).padStart(2, '0');

                return `${ano}-${mes}-${dia} ${hora}:${minuto}:${segundo}`;
            } catch (e) {
                return null;
            }
        };

        const dataInicioClean = extrairTimestampLocal(dataAbertura);
        const dataFimClean = extrairTimestampLocal(dataFechamento);

        console.log(`[POSTGRES] Buscando período estrito: Inicial: ${dataInicioClean} | Final: ${dataFimClean}`);

        if (this.isOnline) {
            try {
                // CAPTURA DOS IDS GLOBAIS DE GOVERNANÇA EM MEMÓRIA (REPLACES A QUERY ANTIGA)
                const empIdGlobal = this.tenantEmpresaId;
                const filIdGlobal = this.tenantFilialId;

                if (!empIdGlobal) {
                    throw new Error('Dados de governança (Empresa ID) ausentes no escopo em memória.');
                }

                // Query limpa, precisa e livre de INTERVALs sobrepostos utilizando as globais estáveis
                const queryPG = `
                    SELECT origem, total, forma_pagamento, descricao_movimento, data_venda, bandeira, parcelas
                    FROM vendas
                    WHERE caixa_id = $1 
                      AND data_venda >= $2::timestamp
                      AND data_venda <= $3::timestamp
                      AND empresa_id = $4
                      AND filial_id = $5
                      AND deletado = false
                    ORDER BY data_venda DESC
                `;
                const res = await this.pgClient.query(queryPG, [caixaId, dataInicioClean, dataFimClean, empIdGlobal, filIdGlobal]);
                
                this.isOnline = true;
                return res.rows;
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
            console.log("[BANCO] Iniciando contagem dos status de sincronizacao local...");
            
            const tabelas = {
                vendas: 'vendas_locais',
                turnos: 'movimentos_caixa_locais',
                recebiveis: 'recebiveis_cartao_locais',
                crediario: 'contas_a_receber_locais'
            };
            const resultado = {};

            for (const [chave, nomeTabela] of Object.entries(tabelas)) {
                try {
                    resultado[chave] = await new Promise((resolve, reject) => {
                        this.sqliteDb.get(
                            `SELECT COUNT(*) as total, SUM(CASE WHEN sincronizado = 0 THEN 1 ELSE 0 END) as pendentes FROM ${nomeTabela}`,
                            [],
                            (err, row) => {
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve({
                                        total: row ? row.total : 0,
                                        pendentes: row ? (row.pendentes || 0) : 0
                                    });
                                }
                            }
                        );
                    });
                } catch (errTable) {
                    console.error(`[ERRO - obterStatusSincronizacao (Tabela: ${nomeTabela})]:`, errTable.message);
                    // Define valor zerado seguro em caso de erro na tabela para nao corromper o retorno das demais
                    resultado[chave] = { total: 0, pendentes: 0 };
                }
            }

            console.log("[BANCO] Auditoria de sincronizacao concluida com sucesso.");
            return resultado;

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - obterStatusSincronizacao FATAL]: Excecao nao tratada na contagem de pendencias:", errGlobal.message);
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
                console.log("[SYNC-MANUAL] Falha: Tentativa de execucao sem conexao ativa com o Postgres.");
                throw new Error("Sem conexao ativa com o servidor PostgreSQL central.");
            }
            
            // REAPROVEITAMENTO DAS VARIÁVEIS GLOBAIS DE GOVERNANÇA EM MEMÓRIA
            const empIdGlobal = this.tenantEmpresaId;
            const filIdGlobal = this.tenantFilialId;

            if (!empIdGlobal) {
                console.log("[SYNC-MANUAL] Falha: Parametros de governanca ausentes no escopo.");
                throw new Error("Erro de escopo: Identificadores de governanca do terminal nao estao carregados na sessao.");
            }

            const logs = [];
            logs.push(`[${new Date().toLocaleTimeString()}] 🚀 Iniciando sincronizacao da tabela: ${tipo.toUpperCase()}`);

            if (tipo === 'vendas') {
                let pendentes = [];
                try {
                    console.log("[SYNC-MANUAL] Coletando vendas pendentes no SQLite local...");
                    pendentes = await new Promise((resolve, reject) => {
                        this.sqliteDb.all(`SELECT * FROM vendas_locais WHERE sincronizado = 0`, [], (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
                        });
                    });
                } catch (errLite) {
                    console.error("[ERRO - sincronizarTabelaManual (Ler vendas SQLite)]:", errLite.message);
                    logs.push(`[ERRO CRITICO] Falha ao ler a tabela vendas_locais: ${errLite.message}`);
                    throw errLite;
                }

                logs.push(`[INFO] Encontrados ${pendentes.length} lancamentos pendentes.`);
                
                const escopoVendas = this.obterEscopoTabela('vendas');
                const filialPgValor = (escopoVendas === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const v of pendentes) {
                    try {
                        const estaDeletadoPG = (v.deletado === 1);

                        // Aplicados casts explicitos ::uuid e ::timestamp para blindagem do Postgres
                        const queryPG = `
                            INSERT INTO vendas (id, caixa_id, operador_id, cliente_id, forma_pagamento, origem, total, descricao_movimento, data_venda, deletado, bandeira, parcelas, empresa_id, filial_id)
                            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::timestamp, $10::boolean, $11, $12, $13::uuid, $14::uuid)
                            ON CONFLICT (id) DO UPDATE SET deletado = excluded.deletado
                        `;
                        
                        const clientePgValor = (v.cliente_id === 'CONSUMIDOR-FINAL' || !v.cliente_id)
                            ? '00000000-0000-0000-0000-000000000000' 
                            : v.cliente_id;
                                
                        await this.pgClient.query(queryPG, [v.id, v.caixa_id, v.operador_id, clientePgValor, v.forma_pagamento, v.origem, v.total, v.descricao_movimento, v.data_venda, estaDeletadoPG, v.bandeira, v.parcelas, empIdGlobal, filialPgValor]);
                        
                        this.sqliteDb.run(`UPDATE vendas_locais SET sincronizado = 1 WHERE id = ?`, [v.id]);
                        logs.push(`[SUCESSO] Lancamento ID ${v.id.substring(0,8)}... espelhado com a nuvem.`);
                    } catch (errLoopVenda) {
                        console.error(`[ERRO - sincronizarTabelaManual (Lote Venda ID ${v.id})]:`, errLoopVenda.message);
                        logs.push(`[FALHA] Nao foi possivel espelhar a venda ID ${v.id.substring(0,8)}: ${errLoopVenda.message}`);
                    }
                }
            }
            else if (tipo === 'turnos') {
                let pendentes = [];
                try {
                    console.log("[SYNC-MANUAL] Coletando turnos pendentes no SQLite local...");
                    pendentes = await new Promise((resolve, reject) => {
                        this.sqliteDb.all(`SELECT * FROM movimentos_caixa_locais WHERE sincronizado = 0`, [], (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
                        });
                    });
                } catch (errLite) {
                    console.error("[ERRO - sincronizarTabelaManual (Ler movimentos_caixa SQLite)]:", errLite.message);
                    logs.push(`[ERRO CRITICO] Falha ao ler a tabela movimentos_caixa_locais: ${errLite.message}`);
                    throw errLite;
                }

                logs.push(`[INFO] Encontrados ${pendentes.length} fechamentos de turnos pendentes.`);

                const escopoTurnos = this.obterEscopoTabela('movimentos_caixa');
                const filialPgValor = (escopoTurnos === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const t of pendentes) {
                    try {
                        // Aplicados casts explicitos ::uuid, ::timestamp e ::boolean para blindagem do Postgres
                        const queryPG = `
                            INSERT INTO movimentos_caixa (id, caixa_id, operador_abertura_id, operador_fechamento_id, data_abertura, data_fechamento, valor_abertura, valor_fechamento, valor_contado, diferenca, status, deletado, empresa_id, filial_id)
                            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamp, $6::timestamp, $7, $8, $9, $10, $11, $12::boolean, $13::uuid, $14::uuid)
                            ON CONFLICT (id) DO UPDATE SET status = excluded.status, data_fechamento = excluded.data_fechamento, valor_fechamento = excluded.valor_fechamento, valor_contado = excluded.valor_contado, diferenca = excluded.diferenca
                        `;
                        await this.pgClient.query(queryPG, [t.id, t.caixa_id, t.operador_abertura_id, t.operador_fechamento_id, t.data_abertura, t.data_fechamento, t.valor_abertura, t.valor_fechamento, t.valor_contado, t.diferenca, t.status, t.deletado === 1, empIdGlobal, filialPgValor]);
                        
                        await new Promise((resolve) => {
                            this.sqliteDb.run(`UPDATE movimentos_caixa_locais SET sincronizado = 1 WHERE id = ?`, [t.id], () => resolve());
                        });

                        logs.push(`[SUCESSO] Turno ID ${t.id.substring(0,8)}... atualizado no PostgreSQL e marcado localmente.`);
                    } catch (errLoopTurno) {
                        console.error(`[ERRO - sincronizarTabelaManual (Lote Turno ID ${t.id})]:`, errLoopTurno.message);
                        logs.push(`[FALHA] Nao foi possivel espelhar o turno ID ${t.id.substring(0,8)}: ${errLoopTurno.message}`);
                    }
                }
            }
            else if (tipo === 'recebiveis') {
                let pendentes = [];
                try {
                    console.log("[SYNC-MANUAL] Coletando recebiveis pendentes no SQLite local...");
                    pendentes = await new Promise((resolve, reject) => {
                        this.sqliteDb.all(`SELECT * FROM recebiveis_cartao_locais WHERE sincronizado = 0`, [], (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
                        });
                    });
                } catch (errLite) {
                    console.error("[ERRO - sincronizarTabelaManual (Ler recebiveis SQLite)]:", errLite.message);
                    logs.push(`[ERRO CRITICO] Falha ao ler a tabela recebiveis_cartao_locais: ${errLite.message}`);
                    throw errLite;
                }

                logs.push(`[INFO] Encontrados ${pendentes.length} recebiveis de cartao pendentes.`);

                const escopoRecebiveis = this.obterEscopoTabela('recebiveis_cartao');
                const filialRecPgValor = (escopoRecebiveis === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const r of pendentes) {
                    try {
                        // Aplicados casts explicitos ::uuid, ::timestamp e ::boolean para blindagem do Postgres
                        const queryPG = `
                            INSERT INTO recebiveis_cartao (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, deletado, empresa_id, filial_id)
                            VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamp, $7, $8::boolean, $9::uuid, $10::uuid)
                            ON CONFLICT (id) DO UPDATE SET status = excluded.status, deletado = excluded.deletado
                        `;
                        await this.pgClient.query(queryPG, [r.id, r.venda_id, r.caixa_id, r.parcela_numero, r.valor_parcela, r.data_prevista_recebimento, r.status, r.deletado === 1, empIdGlobal, filialRecPgValor]);
                        this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET sincronizado = 1 WHERE id = ?`, [r.id]);
                        logs.push(`[SUCESSO] Recebivel ID ${r.id.substring(0,8)}... espelhado com a nuvem.`);
                    } catch (errLoopRec) {
                        console.error(`[ERRO - sincronizarTabelaManual (Lote Recebivel ID ${r.id})]:`, errLoopRec.message);
                        logs.push(`[FALHA] Nao foi possivel espelhar o recebivel ID ${r.id.substring(0,8)}: ${errLoopRec.message}`);
                    }
                }
            }
            else if (tipo === 'crediario') {
                let pendentes = [];
                try {
                    console.log("[SYNC-MANUAL] Coletando crediarios pendentes no SQLite local...");
                    pendentes = await new Promise((resolve, reject) => {
                        this.sqliteDb.all(`SELECT * FROM contas_a_receber_locais WHERE sincronizado = 0`, [], (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
                        });
                    });
                } catch (errLite) {
                    console.error("[ERRO - sincronizarTabelaManual (Ler crediario SQLite)]:", errLite.message);
                    logs.push(`[ERRO CRITICO] Falha ao ler a tabela contas_a_receber_locais: ${errLite.message}`);
                    throw errLite;
                }

                logs.push(`[INFO] Encontrados ${pendentes.length} titulos de parcelas de crediario pendentes.`);

                const escopoCR = this.obterEscopoTabela('contas_a_receber');
                const filialCRPgValor = (escopoCR === 'COMPARTILHADO') ? null : filIdGlobal;

                for (const c of pendentes) {
                    try {
                        // Captura metadados da venda pai para estruturar o total de parcelamento correto
                        const vendaPai = await new Promise((resolve) => {
                            this.sqliteDb.get(`SELECT data_venda, parcelas FROM vendas_locais WHERE id = ?`, [c.venda_id], (err, row) => resolve(row));
                        });
                        const dataEmissao = vendaPai ? vendaPai.data_venda : obterDataHoraLocalANSI();
                        const totalParcelasVenda = vendaPai ? vendaPai.parcelas : 1;

                        // Descobre a numeração de parcela fazendo contagem de registros anteriores da mesma venda
                        const ordemParcela = await new Promise((resolve) => {
                            this.sqliteDb.get(`SELECT COUNT(*) as indexador FROM contas_a_receber_locais WHERE venda_id = ? AND id <= ?`, [c.venda_id, c.id], (err, row) => resolve(row ? row.indexador : 1));
                        });

                        // Aplicados casts explicitos ::uuid, ::timestamp, ::date e ::boolean para blindagem do Postgres
                        const queryCRPostgres = `
                            INSERT INTO contas_a_receber (id, empresa_id, filial_id, venda_id, cliente_id, parcela_numero, total_parcelas, data_emissao, data_vencimento, valor_original, valor_juros, valor_multa, valor_pago, saldo_restante, status, deletado)
                            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::timestamp, $9::date, $10, 0.00, 0.00, 0.00, $11, 'P', false)
                            ON CONFLICT (id) DO UPDATE SET status = excluded.status
                        `;
                        
                        await this.pgClient.query(queryCRPostgres, [
                            c.id, empIdGlobal, filialCRPgValor, c.venda_id, c.cliente_id, 
                            ordemParcela, totalParcelasVenda, dataEmissao, c.data_vencimento, c.valor_original, c.valor_original
                        ]);
                        
                        this.sqliteDb.run(`UPDATE contas_a_receber_locais SET sincronizado = 1 WHERE id = ?`, [c.id]);
                        logs.push(`[SUCESSO] Parcela ${ordemParcela}/${totalParcelasVenda} do Titulo ID ${c.id.substring(0,8)}... espelhada na nuvem.`);
                    } catch (errLoopCR) {
                        console.error(`[ERRO - sincronizarTabelaManual (Lote Crediario ID ${c.id})]:`, errLoopCR.message);
                        logs.push(`[FALHA] Nao foi possivel espelhar a parcela do crediario ID ${c.id.substring(0,8)}: ${errLoopCR.message}`);
                    }
                }
            }

            logs.push(`[${new Date().toLocaleTimeString()}] ✅ Sincronizacao concluida com sucesso!`);
            return logs;

        } catch (errGlobal) {
            console.error("[ERRO CRITICO - sincronizarTabelaManual FATAL]: Excecao nao tratada na rotina de sincronismo manual:", errGlobal.message);
            return [`[ERRO FATAL - ${new Date().toLocaleTimeString()}] Ocorreu um erro geral nao tratado: ${errGlobal.message}`];
        }
    }

}

module.exports = new DatabaseManager();