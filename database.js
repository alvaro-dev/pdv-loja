const { Client } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

// 🌟 FUNÇÃO AUXILIAR: Gera data e hora local da máquina sem distorção de fuso horário (UTC)
function obterDataHoraLocalANSI(dataBase = new Date()) {
    const ano = dataBase.getFullYear();
    const mes = String(dataBase.getMonth() + 1).padStart(2, '0');
    const dia = String(dataBase.getDate()).padStart(2, '0');
    const hora = String(dataBase.getHours()).padStart(2, '0');
    const minuto = String(dataBase.getMinutes()).padStart(2, '0');
    const segundo = String(dataBase.getSeconds()).padStart(2, '0');

    // Retorna exatamente no formato "YYYY-MM-DD HH:MM:SS" (ex: 2026-07-06 20:30:41)
    return `${ano}-${mes}-${dia} ${hora}:${minuto}:${segundo}`;
}

class DatabaseManager {
    constructor() {
        this.isOnline = false;
        this.pgClient = null;
        this.sqliteDb = null;
        
        // 🌐 VARIÁVEIS GLOBAIS DE TENANT DO TERMINAL
        this.tenantEmpresaId = null;
        this.tenantFilialId = null;

        // No Windows, salva o arquivo .db na pasta AppData do usuário
        this.sqlitePath = path.join(app.getPath('userData'), 'pdv_local.db');
    }

    // 🔒 Função auxiliar para criptografar a senha em SHA-256 antes de comparar ou salvar
    gerarHashSenha(senha) {
        return crypto.createHash('sha256').update(senha).digest('hex');
    }

    async realizarLogin(usuario, senha, caixaId) {
        // HIGIENIZAÇÃO E CONVERSÃO ESTRITA
        const usuarioStr = String(usuario || '').trim();
        const senhaStr = String(senha || '').trim();
        const caixaIdStr = caixaId ? String(caixaId).trim() : null;
        
        console.log(`\n💾 [DB-LOGIN] Entrando na verificação do banco...`);
        console.log(`👉 Recebido -> Usuário: "${usuarioStr}" | Senha original: "${senhaStr}"`);

        // 🔒 Verifica se já é o hash de 64 caracteres ou texto puro
        const senhaCriptografada = (senhaStr.length === 64) 
            ? senhaStr 
            : this.gerarHashSenha(senhaStr);
        
        console.log(`🔒 [DB-LOGIN] Tratamento final da senha -> Hash SHA-256 gerado/mantido: "${senhaCriptografada}"`);
        
        let operador = null;

        // 1. SE ESTIVER ONLINE, TENTA VALIDAR NO POSTGRESQL
        if (this.isOnline) {
            try {
                console.log(`📡 [DB-LOGIN] Buscando usuário no PostgreSQL externo...`);
                const query = "SELECT id, usuario, nome, role, bloqueado, trocar_senha_prox_login FROM usuarios WHERE usuario = $1 AND senha = $2 AND usuario_pdv = 'S' AND deletado = false";
                const resultado = await this.pgClient.query(query, [usuarioStr, senhaCriptografada]);
                
                if (resultado.rows.length > 0) {
                    operador = resultado.rows[0];
                    console.log(`📡 [DB-LOGIN] Localizado no Postgres!`);
                    
                    // Sincroniza na base local
                    this.sqliteDb.run(
                        `INSERT INTO usuarios_locais (id, usuario, nome, senha, role, bloqueado, usuario_pdv, trocar_senha_prox_login) 
                        VALUES (?, ?, ?, ?, ?, 'N', 'S', ?) 
                        ON CONFLICT(usuario) DO UPDATE SET nome=?, senha=?, role=?, trocar_senha_prox_login=?`,
                        [operador.id, operador.usuario, operador.nome, senhaCriptografada, operador.role, operador.trocar_senha_prox_login, operador.nome, senhaCriptografada, operador.role, operador.trocar_senha_prox_login]
                    );
                } else {
                    console.log(`⚠️ [DB-LOGIN] Combinação usuário/senha não encontrada no Postgres.`);
                }
            } catch (err) {
                console.log("Erro no login do Postgres, tentando SQLite...", err);
                this.isOnline = false;
            }
        }

        // 2. MODO OFFLINE DE CONTINGÊNCIA
        if (!operador) {
            operador = await new Promise((resolve, reject) => {
                const query = "SELECT id, usuario, nome, role, bloqueado FROM usuarios_locais WHERE usuario = ? AND senha = ? AND usuario_pdv = 'S' AND deletado = 0";
                this.sqliteDb.get(query, [usuarioStr, senhaCriptografada], (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                });
            });
        }

        if (!operador) return null; 

        // =====================================================================
        // 🌟 EXCEÇÃO MASTER ANTECIPADA: Admins pulam qualquer trava de turno!
        // =====================================================================
        if (operador.role === 'admin' || operador.usuario === 'admin') {
            console.log(`🔓 [LOGIN] Administrador "${operador.nome}" autenticado com sucesso.`);
            return operador;
        }

        // =====================================================================
        // 3. TRAVA A: Verifica se o terminal atual pertence a outro operador
        // =====================================================================
        if (caixaIdStr) {
            let caixaDono = null;
            
            if (this.isOnline) {
                try {
                    const queryCaixa = `
                        SELECT m.operador_abertura_id, o.nome AS dono_nome 
                        FROM movimentos_caixa m
                        JOIN usuarios o ON o.id = m.operador_abertura_id AND o.deletado = false
                        WHERE m.caixa_id = $1 AND m.status = 'A' AND m.deletado = false
                        LIMIT 1
                    `;
                    const resCaixa = await this.pgClient.query(queryCaixa, [caixaIdStr]);
                    if (resCaixa.rows.length > 0) caixaDono = resCaixa.rows[0];
                } catch (err) { this.isOnline = false; }
            }

            if (!this.isOnline) {
                caixaDono = await new Promise((resolve) => {
                    this.sqliteDb.get(
                        `SELECT m.operador_abertura_id, 'Outro Operador (Offline)' AS dono_nome 
                        FROM movimentos_caixa_locais m 
                        WHERE m.caixa_id = ? AND m.status = 'A' AND m.deletado = 0`,
                        [caixaIdStr], (err, row) => resolve(row)
                    );
                });
            }

            if (caixaDono && caixaDono.operador_abertura_id !== operador.id) {
                throw new Error(`Este terminal já possui um turno ativo do operador: "${caixaDono.dono_nome}". Finalize o turno atual antes de trocar de operador.`);
            }
        }

        // =====================================================================
        // 4. TRAVA B: Verifica se este operador comum já tem outro caixa aberto
        // =====================================================================
        let turnoAtivo = null;
        if (this.isOnline) {
            try {
                const queryTrava = `
                    SELECT m.id, c.descricao AS caixa_nome, c.id AS cod_caixa
                    FROM movimentos_caixa m
                    JOIN caixas c ON c.id = m.caixa_id AND c.deletado = false
                    WHERE m.operador_abertura_id = $1 AND m.status = 'A' AND m.deletado = false
                    LIMIT 1
                `;
                const resTrava = await this.pgClient.query(queryTrava, [operador.id]);
                if (resTrava.rows.length > 0) turnoAtivo = resTrava.rows[0];
            } catch (err) { this.isOnline = false; }
        }

        if (!this.isOnline) {
            turnoAtivo = await new Promise((resolve) => {
                this.sqliteDb.get(
                    `SELECT m.id, 'outro terminal (Offline)' AS caixa_nome, c.id AS cod_caixa 
                    FROM movimentos_caixa_locais m 
                    JOIN caixas_locais c ON c.id = m.caixa_id AND c.deletado = 0
                    WHERE m.operador_abertura_id = ? AND m.status = 'A' AND m.deletado = 0`,
                    [operador.id], (err, row) => resolve(row)
                );
            });
        }

        if (turnoAtivo) {
            if (String(turnoAtivo.cod_caixa).trim() !== caixaIdStr) {
                throw new Error(`Este operador já possui um turno aberto no terminal: "${turnoAtivo.caixa_nome}". Encerre a outra sessão antes.`);
            }
        }

        return operador;
    }

    // Atualize por completo o método obterDadosCaixa
    async obterDadosCaixa(caixaId) {
        const caixaLocal = await new Promise((resolve) => {
            const queryLocal = 'SELECT id, descricao, empresa_id, filial_id FROM caixas_locais WHERE id = ? AND deletado = 0';
            this.sqliteDb.get(queryLocal, [caixaId], (err, row) => {
                if (err) resolve(null);
                else resolve(row || null);
            });
        });

        if (caixaLocal && caixaLocal.empresa_id && caixaLocal.filial_id) {
            console.log("💾 [LOCAL] IDs de Empresa e Filial carregados com sucesso do SQLite.");
            
            this.tenantEmpresaId = caixaLocal.empresa_id;
            this.tenantFilialId = caixaLocal.filial_id;

            return {
                id: caixaLocal.id,
                descricao: caixaLocal.descricao,
                empresa_id: caixaLocal.empresa_id,
                filial_id: caixaLocal.filial_id,
                empresa_nome: "Grupo Alfa Varejo", // 🌟 ADICIONADO PARA O FRONT-END
                filial_nome: "Alfa Matriz"         // 🌟 ADICIONADO PARA O FRONT-END
            };
        }

        if (this.isOnline) {
            try {
                const queryPG = 'SELECT id, descricao, empresa_id, filial_id FROM caixas WHERE id = $1 AND deletado = false';
                const resultado = await this.pgClient.query(queryPG, [caixaId]);
                
                if (resultado.rows.length > 0) {
                    const caixa = resultado.rows[0];
                    
                    this.tenantEmpresaId = caixa.empresa_id;
                    this.tenantFilialId = caixa.filial_id;
                    
                    await new Promise((resolve) => {
                        this.sqliteDb.run(
                            `INSERT INTO caixas_locais (id, descricao, empresa_id, filial_id, deletado) 
                            VALUES (?, ?, ?, ?, 0) 
                            ON CONFLICT(id) DO UPDATE SET descricao=?, empresa_id=?, filial_id=?`,
                            [caixa.id, caixa.descricao, caixa.empresa_id, caixa.filial_id, caixa.descricao, caixa.empresa_id, caixa.filial_id],
                            () => resolve()
                        );
                    });
                    
                    console.log("🔌 [POSTGRES] Dados de governança baixados e salvos no SQLite Local.");
                    return {
                        id: caixa.id,
                        descricao: caixa.descricao,
                        empresa_id: caixa.empresa_id,
                        filial_id: caixa.filial_id,
                        empresa_nome: "Grupo Alfa Varejo", // 🌟 ADICIONADO PARA O FRONT-END
                        filial_nome: "Alfa Matriz"         // 🌟 ADICIONADO PARA O FRONT-END
                    };
                }
            } catch (err) {
                console.log("Erro ao sincronizar dados do caixa com Postgres:", err);
                this.isOnline = false;
            }
        }

        return caixaLocal; 
    }

    // 🌟 MODIFICADO: Agora o método init recebe as credenciais lidas do JSON pelo Main
    // 🌟 ATUALIZADO: Livre de strings chumbadas e com validação rigorosa de parâmetros
    async init(configBanco) {
        console.log(`[Banco Local] Caminho do SQLite: ${this.sqlitePath}`); //
        
        // 1. Inicializa o SQLite (Sempre ativo como porto seguro/contingência)
        this.sqliteDb = new sqlite3.Database(this.sqlitePath); //
        this.initSQLiteTables(); //

        // 2. Validação das Credenciais do PostgreSQL externas
        if (!configBanco || !configBanco.host || !configBanco.database || !configBanco.user || !configBanco.password) {
            this.isOnline = false; //
            console.log("==========================================================================");
            console.error("🔴 ERRO CONEXÃO POSTGRESQL: Parâmetros inválidos ou não existem no config.json!");
            console.log("👉 Conectando em modo OFFLINE de contingência (Apenas SQLite Local Ativo).");
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
                connectionTimeoutMillis: 3000 //
            });

            await this.pgClient.connect(); //
            this.isOnline = true; //
            console.log("🔌 [DATABASE] Conectado ao PostgreSQL externo com sucesso!");
        } catch (err) {
            this.isOnline = false; //
            console.log(`⚠️ [DATABASE] Servidor Postgres inacessível (${err.message}). Modo OFFLINE ativo.`); //
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
                trocar_senha_prox_login TEXT NOT NULL DEFAULT 'N'
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
        
        // 3. Cria a nova tabela de vendas locais (ATUALIZADA)
        // 🛠️ ATUALIZADO: Incluindo 'bandeira' e 'parcelas' na criação da tabela local
        this.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS vendas_locais (
                id TEXT PRIMARY KEY,
                caixa_id TEXT NOT NULL,
                operador_id TEXT NOT NULL,
                forma_pagamento TEXT NOT NULL,
                origem TEXT NOT NULL,
                total REAL NOT NULL,
                descricao_movimento TEXT,
                data_venda TEXT NOT NULL,
                sincronizado INTEGER DEFAULT 0,
                deletado INTEGER DEFAULT 0,
                bandeira TEXT,         -- 🌟 ADICIONADO AQUI
                parcelas INTEGER DEFAULT 1 -- 🌟 ADICIONADO AQUI
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
        
    }

    async sincronizarOperadores() {
        if (!this.isOnline || !this.pgClient) {
            console.log("[SYNC] Sistema em modo offline. Pulando carga de operadores.");
            return { status: 'offline', manager: 'Sem conexão estabelecida com o servidor.' };
        }

        // 🌟 NOVA VALIDAÇÃO DE SEGURANÇA: Se o terminal não carregou a Empresa/Filial local, não sabe quem sincronizar
        if (!this.tenantEmpresaId || !this.tenantFilialId) {
            console.log("[SYNC] ⚠️ Empresa ou Filial do terminal não carregadas em memória. Abortando sync de operadores por segurança.");
            return { status: 'erro', mensagem: 'IDs de governança ausentes no boot.' };
        }

        try {
            console.log(`[SYNC] Buscando operadores permitidos para a Empresa: ${this.tenantEmpresaId} | Filial: ${this.tenantFilialId}...`);
            
            // 🌟 CONSULTA POSTGRESQL ATUALIZADA:
            // Cruza a tabela 'usuarios' com a 'usuarios_acessos' para validar quem tem permissão explícita nesta unidade
            // 🌟 CONSULTA POSTGRESQL CORRIGIDA: Removido o filtro 'a.deletado' que não existe na pivô
            const queryPG = `
                SELECT DISTINCT
                    u.id, 
                    u.usuario, 
                    u.nome, 
                    u.senha, 
                    u.role, 
                    u.bloqueado, 
                    u.usuario_pdv, 
                    u.trocar_senha_prox_login
                FROM usuarios u
                JOIN usuarios_acessos a ON a.usuario_id = u.id
                WHERE u.usuario_pdv = 'S' 
                  AND u.deletado = false
                  AND a.empresa_id = $1 
                  AND a.filial_id = $2
            `;
            
            const resultado = await this.pgClient.query(queryPG, [this.tenantEmpresaId, this.tenantFilialId]);
            const operadoresServidor = resultado.rows;

            console.log(`[SYNC] Gravar ${operadoresServidor.length} operadores autorizados no SQLite...`);

            return new Promise((resolve, reject) => {
                this.sqliteDb.serialize(() => {
                    this.sqliteDb.run("BEGIN TRANSACTION");

                    const stmt = this.sqliteDb.prepare(`
                        INSERT INTO usuarios_locais (id, usuario, nome, senha, role, bloqueado, usuario_pdv, trocar_senha_prox_login)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(usuario) DO UPDATE SET 
                            id = excluded.id,
                            nome = excluded.nome,
                            senha = excluded.senha,
                            role = excluded.role,
                            bloqueado = excluded.bloqueado,
                            usuario_pdv = excluded.usuario_pdv,
                            trocar_senha_prox_login = excluded.trocar_senha_prox_login
                    `);

                    for (const op of operadoresServidor) {
                        stmt.run([op.id, op.usuario, op.nome, op.senha, op.role, op.bloqueado, op.usuario_pdv, op.trocar_senha_prox_login]);
                    }

                    stmt.finalize();

                    this.sqliteDb.run("COMMIT", (err) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({ status: 'sucesso', total: operadoresServidor.length });
                        }
                    });
                });
            });

        } catch (error) {
            console.error("[SYNC] Conexão com o Postgres falhou durante a sincronização de operadores:", error.message);
            this.isOnline = false; 
            return { 
                status: 'offline_contingencia', 
                mensagem: 'Conexão perdida com o servidor. Usando dados locais pré-existentes.' 
            };
        }
    }

    async verificarCaixaAberto(caixaId) {
        if (this.isOnline) {
            try {
                const query = `SELECT id FROM movimentos_caixa WHERE caixa_id = $1 AND status = 'A' AND deletado = false LIMIT 1 `;
                const res = await this.pgClient.query(query, [caixaId]);
                return res.rows.length > 0;
            } catch (err) {
                this.isOnline = false;
            }
        }
        
        return new Promise((resolve) => {
            this.sqliteDb.get(`SELECT id FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A' AND deletado = 0`, [caixaId], (err, row) => {
                resolve(!!row);
            });
        });
    }

    async abrirCaixa(caixaId, operadorId, valorAbertura) {
        const idMovimento = crypto.randomUUID();
        // 🌟 CORREÇÃO: Substituído o .toISOString() pela função local pura
        const dataAtual = obterDataHoraLocalANSI();
        let empresaId = null;
        let filialId = null;

        // Recupera de qual Empresa/Filial este Caixa é para espelhar
        if (this.isOnline) {
            try {
                const resCx = await this.pgClient.query('SELECT empresa_id, filial_id FROM caixas WHERE id = $1', [caixaId]);
                if (resCx.rows.length > 0) {
                    empresaId = resCx.rows[0].empresa_id;
                    filialId = resCx.rows[0].filial_id;
                }
            } catch (err) { this.isOnline = false; }
        }

        if (this.isOnline && empresaId && filialId) {
            try {
                // 🛠️ ATUALIZADO: Adicionado os campos relacionais
                const queryPG = `
                    INSERT INTO movimentos_caixa (id, caixa_id, operador_abertura_id, data_abertura, valor_abertura, status, empresa_id, filial_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `;
                await this.pgClient.query(queryPG, [idMovimento, caixaId, operadorId, dataAtual, valorAbertura, 'A', empresaId, filialId]);
                console.log("[BANCO] Turno de caixa aberto com sucesso no PostgreSQL.");
            } catch (err) {
                console.error("[BANCO] Erro ao abrir no Postgres, mudando para contingência offline:", err.message);
                this.isOnline = false; 
            }
        }

        const jaSincronizado = this.isOnline ? 1 : 0; // 🌟 Identifica se subiu na hora pro Postgres

        return new Promise((resolve, reject) => {
            const queryLite = `
                INSERT INTO movimentos_caixa_locais (id, caixa_id, operador_abertura_id, data_abertura, valor_abertura, status, sincronizado) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
            
            this.sqliteDb.run(
                queryLite, 
                [idMovimento, caixaId, operadorId, dataAtual, valorAbertura, 'A', jaSincronizado], 
                (err) => {
                    if (err) {
                        console.error("[BANCO] Erro crítico ao salvar no SQLite:", err);
                        reject(err);
                    } else {
                        console.log(`[BANCO] Turno de caixa aberto com sucesso no SQLite (Sincronizado: ${jaSincronizado}).`);
                        resolve({ status: 'sucesso', id: idMovimento });
                    }
                }
            );
        });
    }

    async registrarVenda(caixaId, operadorId, total, formaPagamento, origem, descricaoMovimento, bandeira = null, parcelas = 1) {
        const idVenda = crypto.randomUUID();
        // 🌟 CORREÇÃO: Data da venda gravada com base no relógio local do Windows
        const dataAtual = obterDataHoraLocalANSI();

        // 1. SALVA A VENDA NO SQLITE LOCAL PRIMEIRO
        await new Promise((resolve, reject) => {
            const queryLite = `
                INSERT INTO vendas_locais (id, caixa_id, operador_id, forma_pagamento, origem, total, descricao_movimento, data_venda, sincronizado, deletado, bandeira, parcelas) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
            `;
            this.sqliteDb.run(
                queryLite, 
                [idVenda, caixaId, operadorId, formaPagamento, origem, total, descricaoMovimento, dataAtual, bandeira, parcelas], 
                (err) => { if (err) reject(err); else resolve(); }
            );
        });

        // GENERACAO DE PARCELAS NO SQLITE LOCAL
        if (formaPagamento === 'CC' && total > 0) {
            const valorPorParcela = total / parcelas;
            for (let i = 1; i <= parcelas; i++) {
                const idRecebivel = crypto.randomUUID();
                const dataPrevista = new Date();
                dataPrevista.setDate(dataPrevista.getDate() + (30 * i));
                
                // 🌟 CORREÇÃO: Formata a data de recebimento futuro sem fuso UTC
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
        }

        // 2. SE ESTIVER ONLINE, REPLICA TUDO PRO POSTGRES UTILIZANDO O TENANT DO CAIXA
        if (this.isOnline) {
            try {
                // Captura a Empresa e Filial vinculadas ao Caixa ativo
                const resCx = await this.pgClient.query('SELECT empresa_id, filial_id FROM caixas WHERE id = $1', [caixaId]);
                if (resCx.rows.length === 0) throw new Error('Caixa operacional não localizado no PostgreSQL.');
                
                const { empresa_id, filial_id } = resCx.rows[0];

                // Insere Venda no PG com as novas colunas obrigatórias
                const queryPG = `
                    INSERT INTO vendas (id, caixa_id, operador_id, forma_pagamento, origem, total, descricao_movimento, data_venda, bandeira, parcelas, empresa_id, filial_id) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `;
                await this.pgClient.query(queryPG, [idVenda, caixaId, operadorId, formaPagamento, origem, total, descricaoMovimento, dataAtual, bandeira, parcelas, empresa_id, filial_id]);
                
                // Se gerou parcelas, move os recebíveis locais desse ID para o Postgres injetando a Filial
                if (formaPagamento === 'CC') {
                    const recebiveis = await new Promise((resolve) => {
                        this.sqliteDb.all(`SELECT * FROM recebiveis_cartao_locais WHERE venda_id = ?`, [idVenda], (err, rows) => resolve(rows || []));
                    });

                    for (const rec of recebiveis) {
                        await this.pgClient.query(`
                            INSERT INTO recebiveis_cartao (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, empresa_id, filial_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        `, [rec.id, idVenda, caixaId, rec.parcela_numero, rec.valor_parcela, rec.data_prevista_recebimento, 'P', empresa_id, filial_id]);
                        
                        this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET sincronizado = 1 WHERE id = ?`, [rec.id]);
                    }
                }

                this.sqliteDb.run(`UPDATE vendas_locais SET sincronizado = 1 WHERE id = ?`, [idVenda]);
                return { status: 'sucesso', modo: 'ONLINE', id: idVenda };
            } catch (err) {
                console.log("Erro ao espelhar transação no Postgres:", err.message);
                this.isOnline = false;
            }
        }

        return { status: 'sucesso', modo: 'OFFLINE (SQLite)', id: idVenda };
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
        if (!this.isOnline) return { status: 'offline' };

        return new Promise((resolve) => {
            this.sqliteDb.all(`SELECT * FROM vendas_locais WHERE sincronizado = 0`, [], async (err, vendasPendentes) => {
                if (err) {
                    console.error("[SYNC] Erro ao ler SQLite:", err);
                    return resolve({ status: 'erro' });
                }

                if (vendasPendentes.length === 0) {
                    return resolve({ status: 'limpo', total: 0 }); 
                }

                console.log(`[SYNC] Sincronizando ${vendasPendentes.length} atualizações com a nuvem...`);

                try {
                    for (const venda of vendasPendentes) {
                        // Converte o status 0 ou 1 do SQLite para true/false do Postgres
                        const estaDeletadoPG = (venda.deletado === 1);

                        // 🛠️ MUDANÇA CRUCIAL: Se houver conflito de ID, atualiza o campo deletado
                        // Dentro de sincronizarTabelaManual (bloco de vendas) e sincronizarVendasPendentes:
                        const resCx = await this.pgClient.query('SELECT empresa_id, filial_id FROM caixas WHERE id = $1', [v.caixa_id]);
                        const empId = resCx.rows[0]?.empresa_id;
                        const filId = resCx.rows[0]?.filial_id;

                        const queryPG = `
                            INSERT INTO vendas (id, caixa_id, operador_id, forma_pagamento, origem, total, descricao_movimento, data_venda, deletado, bandeira, parcelas, empresa_id, filial_id)
                                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                                        ON CONFLICT (id) DO UPDATE SET deletado = excluded.deletado
                        `;
                        
                        await this.pgClient.query(queryPG, [v.id, v.caixa_id, v.operador_id, v.forma_pagamento, v.origem, v.total, v.descricao_movimento, v.data_venda, estaDeletadoPG, v.bandeira, v.parcelas, empId, filId]);
                        this.sqliteDb.run(`UPDATE vendas_locais SET sincronizado = 1 WHERE id = ?`, [venda.id]);
                    }

                    console.log(`[SYNC] Sincronização e auditoria concluídas com sucesso!`);
                    resolve({ status: 'sucesso', total: vendasPendentes.length });

                } catch (error) {
                    console.error("[SYNC] Erro no lote de envio:", error.message);
                    this.isOnline = false;
                    resolve({ status: 'erro_rede' });
                }
            });
        });
    }

    async obterResumoTurnoAtual(caixaId) {
        let movimento = null;
        
        if (this.isOnline) {
            try {
                const res = await this.pgClient.query(
                    `SELECT id, valor_abertura, data_abertura FROM movimentos_caixa WHERE caixa_id = $1 AND status = 'A' AND deletado = false LIMIT 1`, 
                    [caixaId]
                );
                if (res.rows.length > 0) movimento = res.rows[0];
            } catch (err) { this.isOnline = false; }
        }
        
        if (!movimento) {
            movimento = await new Promise((resolve) => {
                this.sqliteDb.get(
                    `SELECT id, valor_abertura, data_abertura FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A' AND deletado = 0`, 
                    [caixaId], (err, row) => resolve(row)
                );
            });
        }

        if (!movimento) return { status: 'erro', mensagem: 'Nenhum turno aberto encontrado para este caixa.' };

        const dataAberturaTurno = movimento.data_abertura;

        let vendas = [];
        if (this.isOnline) {
            try {
                const queryPG = `
                    SELECT origem, total, forma_pagamento FROM vendas 
                    WHERE caixa_id = $1 AND data_venda >= $2 AND deletado = false
                `;
                const res = await this.pgClient.query(queryPG, [caixaId, dataAberturaTurno]);
                vendas = res.rows;
            } catch (err) { this.isOnline = false; }
        }
        
        if (!this.isOnline) {
            vendas = await new Promise((resolve) => {
                const queryLite = `
                    SELECT origem, total, forma_pagamento FROM vendas_locais 
                    WHERE caixa_id = ? AND data_venda >= ? AND deletado = 0
                `;
                this.sqliteDb.all(queryLite, [caixaId, dataAberturaTurno], (err, rows) => resolve(rows || []));
            });
        }

        let totalEntradas = 0;
        let totalSaidas = 0;

        const detalheFormas = {
            DN: { nome: 'Dinheiro', entradas: 0, saidas: 0 },
            CC: { nome: 'Cartão de Crédito', entradas: 0, saidas: 0 },
            CD: { nome: 'Cartão de Débito', entradas: 0, saidas: 0 },
            PX: { nome: 'Pix', entradas: 0, saidas: 0 }
        };

        vendas.forEach(v => {
            const valor = parseFloat(v.total);
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

        const fundoInicial = parseFloat(movimento.valor_abertura);
        const saldoFinal = fundoInicial + totalEntradas - totalSaidas;

        return {
            movimentoId: movimento.id,
            fundoInicial,
            totalEntradas,
            totalSaidas,
            saldoFinal,
            detalheFormas: Object.values(detalheFormas)
        };
    }

    async fecharCaixa(movimentoId, operadorFechamentoId, valorFechamento, valorContado, diferenca) {
        // 🌟 CORREÇÃO: Data de fechamento baseada no horário local
        const dataAtual = obterDataHoraLocalANSI();

        if (this.isOnline) {
            try {
                // Atualiza o Postgres na nuvem incluindo os valores de conferência
                const queryPG = `
                    UPDATE movimentos_caixa 
                    SET status = 'F', data_fechamento = $1, operador_fechamento_id = $2, 
                        valor_fechamento = $3, valor_contado = $4, diferenca = $5
                    WHERE id = $6
                `;
                await this.pgClient.query(queryPG, [dataAtual, operadorFechamentoId, valorFechamento, valorContado, diferenca, movimentoId]);
            } catch (err) { this.isOnline = false; }
        }

        const jaSincronizadoFec = this.isOnline ? 1 : 0; // 🌟 Se fechou direto na nuvem, marca como sincronizado local

        return new Promise((resolve, reject) => {
            const queryLite = `
                UPDATE movimentos_caixa_locais 
                SET status = 'F', data_fechamento = ?, operador_fechamento_id = ?, 
                    valor_fechamento = ?, valor_contado = ?, diferenca = ?, sincronizado = ?
                WHERE id = ?
            `;
            this.sqliteDb.run(queryLite, [dataAtual, operadorFechamentoId, valorFechamento, valorContado, diferenca, jaSincronizadoFec, movimentoId], (err) => {
                if (err) reject(err);
                else resolve({ status: 'sucesso' });
            });
        });
    }

    async excluirLancamento(vendaId) {
        // 1. Se estiver online, atualiza na nuvem
        if (this.isOnline) {
            try {
                // Marca a venda como deletada no Postgres
                const queryPG = `UPDATE vendas SET deletado = true WHERE id = $1`;
                await this.pgClient.query(queryPG, [vendaId]);
                
                // Marca as parcelas como deletadas no Postgres
                await this.pgClient.query(`UPDATE recebiveis_cartao SET deletado = true WHERE venda_id = $1`, [vendaId]);

                // Se tudo subiu para a nuvem com sucesso, atualiza o SQLite local como sincronizado
                this.sqliteDb.run(`UPDATE vendas_locais SET deletado = 1, sincronizado = 1 WHERE id = ?`, [vendaId]);
                this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET deletado = 1, sincronizado = 1 WHERE venda_id = ?`, [vendaId]);
                
                console.log(`[BANCO] Lançamento ${vendaId} e seus recebíveis marcados como deletados no Postgres e SQLite.`);
                return { status: 'sucesso' };

            } catch (err) {
                console.error("[BANCO] Erro ao excluir no Postgres, operando local:", err.message);
                this.isOnline = false; // Cai para o modo offline para concluir a operação localmente
            }
        }

        // 2. Modo de contingência offline (Se a internet cair ou o bloco acima falhar)
        return new Promise((resolve, reject) => {
            this.sqliteDb.serialize(() => {
                this.sqliteDb.run("BEGIN TRANSACTION");

                this.sqliteDb.run(`UPDATE vendas_locais SET deletado = 1, sincronizado = 0 WHERE id = ?`, [vendaId]);
                this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET deletado = 1, sincronizado = 0 WHERE venda_id = ?`, [vendaId]);

                this.sqliteDb.run("COMMIT", (err) => {
                    if (err) {
                        console.error("[BANCO] Erro ao atualizar exclusão no SQLite:", err);
                        reject(err);
                    } else {
                        console.log(`[BANCO] Lançamento ${vendaId} e recebíveis marcados para exclusão local (Pendente de Sync).`);
                        resolve({ status: 'sucesso' });
                    }
                });
            });
        });
    }

    async listarVendasTurnoAtual(caixaId) {
        let movimiento = null;
        if (this.isOnline) {
            try {
                const res = await this.pgClient.query(`SELECT data_abertura FROM movimentos_caixa WHERE caixa_id = $1 AND status = 'A' AND deletado = false LIMIT 1`, [caixaId]);
                if (res.rows.length > 0) movimiento = res.rows[0];
            } catch (err) { this.isOnline = false; }
        }
        if (!movimiento) {
            movimiento = await new Promise((resolve) => {
                this.sqliteDb.get(`SELECT data_abertura FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A'  AND deletado = 0`, [caixaId], (err, row) => resolve(row));
            });
        }
        if (!movimiento) return [];

        // 🌟 CORREÇÃO: Adicionado bandeira e parcelas nos dois SELECTs abaixo
        if (this.isOnline) {
            try {
                const res = await this.pgClient.query(`SELECT id, origem, total, forma_pagamento, descricao_movimento, bandeira, parcelas FROM vendas WHERE caixa_id = $1 AND data_venda >= $2 AND deletado = false ORDER BY data_venda DESC`, [caixaId, movimiento.data_abertura]);
                return res.rows;
            } catch (err) { this.isOnline = false; }
        }
        return new Promise((resolve) => {
            this.sqliteDb.all(`SELECT id, origem, total, forma_pagamento, descricao_movimento, bandeira, parcelas FROM vendas_locais WHERE caixa_id = ? AND data_venda >= ? AND deletado = 0 ORDER BY data_venda DESC`, [caixaId, movimiento.data_abertura], (err, rows) => resolve(rows || []));
        });
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

        console.log(`📡 [POSTGRES] Buscando período estrito: Inicial: ${dataInicioClean} | Final: ${dataFimClean}`);

        if (this.isOnline) {
            try {
                // 1. Captura Empresa e Filial do Caixa ativo
                const resCx = await this.pgClient.query('SELECT empresa_id, filial_id FROM caixas WHERE id = $1', [caixaId]);
                if (resCx.rows.length === 0) throw new Error('Caixa operacional não localizado.');
                
                const { empresa_id, filial_id } = resCx.rows[0];

                // 2. Query limpa, precisa e livre de INTERVALs sobrepostos
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
                const res = await this.pgClient.query(queryPG, [caixaId, dataInicioClean, dataFimClean, empresa_id, filial_id]);
                
                this.isOnline = true;
                return res.rows;
            } catch (err) {
                console.error("🔴 ERRO NO EXTRACT PDV POSTGRES:", err.message);
                throw err;
            }
        }

        throw new Error("O sistema encontra-se em modo de contingência offline.");
    }

    // 📊 Retorna o total de linhas e itens pendentes de sincronização do SQLite local
    async obterStatusSincronizacao() {
        const tabelas = {
            vendas: 'vendas_locais',
            turnos: 'movimentos_caixa_locais',
            recebiveis: 'recebiveis_cartao_locais'
        };
        const resultado = {};

        for (const [chave, nomeTabela] of Object.entries(tabelas)) {
            resultado[chave] = await new Promise((resolve) => {
                this.sqliteDb.get(
                    `SELECT COUNT(*) as total, SUM(CASE WHEN sincronizado = 0 THEN 1 ELSE 0 END) as pendentes FROM ${nomeTabela}`,
                    [],
                    (err, row) => {
                        resolve({
                            total: row ? row.total : 0,
                            pendentes: row ? (row.pendentes || 0) : 0
                        });
                    }
                );
            });
        }
        return resultado;
    }

    // 🔄 Executa a sincronização manual por tabela e retorna uma lista de strings de log para a tela
    async sincronizarTabelaManual(tipo) {
        if (!this.isOnline || !this.pgClient) {
            throw new Error("Sem conexão ativa com o servidor PostgreSQL central.");
        }
        
        const logs = [];
        logs.push(`[${new Date().toLocaleTimeString()}] 🚀 Iniciando sincronização da tabela: ${tipo.toUpperCase()}`);

        if (tipo === 'vendas') {
            const pendentes = await new Promise((resolve) => {
                this.sqliteDb.all(`SELECT * FROM vendas_locais WHERE sincronizado = 0`, [], (err, rows) => resolve(rows || []));
            });
            logs.push(`[INFO] Encontrados ${pendentes.length} lançamentos pendentes.`);
            
            for (const v of pendentes) {
                const estaDeletadoPG = (v.deletado === 1);

                // Dentro de sincronizarTabelaManual (bloco de vendas) e sincronizarVendasPendentes:
                const resCx = await this.pgClient.query('SELECT empresa_id, filial_id FROM caixas WHERE id = $1', [v.caixa_id]);
                const empId = resCx.rows[0]?.empresa_id;
                const filId = resCx.rows[0]?.filial_id;

                const queryPG = `
                    INSERT INTO vendas (id, caixa_id, operador_id, forma_pagamento, origem, total, descricao_movimento, data_venda, deletado, bandeira, parcelas, empresa_id, filial_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    ON CONFLICT (id) DO UPDATE SET deletado = excluded.deletado
                `;
                
                await this.pgClient.query(queryPG, [v.id, v.caixa_id, v.operador_id, v.forma_pagamento, v.origem, v.total, v.descricao_movimento, v.data_venda, estaDeletadoPG, v.bandeira, v.parcelas, empId, filId]);
                this.sqliteDb.run(`UPDATE vendas_locais SET sincronizado = 1 WHERE id = ?`, [v.id]);
                logs.push(`[SUCESSO] Lançamento ID ${v.id.substring(0,8)}... espelhado com a nuvem.`);
            }
        } 
        else if (tipo === 'turnos') {
            const pendentes = await new Promise((resolve) => {
                this.sqliteDb.all(`SELECT * FROM movimentos_caixa_locais WHERE sincronizado = 0`, [], (err, rows) => resolve(rows || []));
            });
            logs.push(`[INFO] Encontrados ${pendentes.length} fechamentos de turnos pendentes.`);

            for (const t of pendentes) {
                // 1. Descobre Empresa e Filial do Caixa correspondente para não quebrar o NOT NULL do Postgres
                const resCx = await this.pgClient.query('SELECT empresa_id, filial_id FROM caixas WHERE id = $1', [t.caixa_id]);
                const empId = resCx.rows[0]?.empresa_id;
                const filId = resCx.rows[0]?.filial_id;

                const queryPG = `
                    INSERT INTO movimentos_caixa (id, caixa_id, operador_abertura_id, operador_fechamento_id, data_abertura, data_fechamento, valor_abertura, valor_fechamento, valor_contado, diferenca, status, deletado, empresa_id, filial_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    ON CONFLICT (id) DO UPDATE SET status = excluded.status, data_fechamento = excluded.data_fechamento, valor_fechamento = excluded.valor_fechamento, valor_contado = excluded.valor_contado, diferenca = excluded.diferenca
                `;
                await this.pgClient.query(queryPG, [t.id, t.caixa_id, t.operador_abertura_id, t.operador_fechamento_id, t.data_abertura, t.data_fechamento, t.valor_abertura, t.valor_fechamento, t.valor_contado, t.diferenca, t.status, t.deletado === 1, empId, filId]);
                
                // 🌟 CORREÇÃO CRUCIAL: Força o JavaScript a esperar o SQLite gravar fisicamente o status de sincronizado antes de ir pro próximo loop
                await new Promise((resolve, reject) => {
                    this.sqliteDb.run(`UPDATE movimentos_caixa_locais SET sincronizado = 1 WHERE id = ?`, [t.id], (err) => {
                        if (err) {
                            console.error(`[SQLITE-ERRO] Falha ao marcar turno ${t.id} como sincronizado:`, err);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });

                logs.push(`[SUCESSO] Turno ID ${t.id.substring(0,8)}... atualizado no PostgreSQL e marcado localmente.`);
            }
        }
        else if (tipo === 'recebiveis') {
            const pendentes = await new Promise((resolve) => {
                this.sqliteDb.all(`SELECT * FROM recebiveis_cartao_locais WHERE sincronizado = 0`, [], (err, rows) => resolve(rows || []));
            });
            logs.push(`[INFO] Encontrados ${pendentes.length} recebíveis de cartão pendentes.`);

            // Dentro de sincronizarTabelaManual (bloco de recebiveis):
            const resCx = await this.pgClient.query('SELECT empresa_id, filial_id FROM caixas WHERE id = $1', [r.caixa_id]);
            const empId = resCx.rows[0]?.empresa_id;
            const filId = resCx.rows[0]?.filial_id;

            for (const r of pendentes) {
                const queryPG = `
                    INSERT INTO recebiveis_cartao (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, deletado, empresa_id, filial_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (id) DO UPDATE SET status = excluded.status, deletado = excluded.deletado
                `;
                await this.pgClient.query(queryPG, [r.id, r.venda_id, r.caixa_id, r.parcela_numero, r.valor_parcela, r.data_prevista_recebimento, r.status, r.deletado === 1, empId, filId]);
                this.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET sincronizado = 1 WHERE id = ?`, [r.id]);
                logs.push(`[SUCESSO] Recebível ID ${r.id.substring(0,8)}... espelhado com a nuvem.`);
            }
        }

        logs.push(`[${new Date().toLocaleTimeString()}] ✅ Sincronização concluída com sucesso!`);
        return logs;
    }

}

module.exports = new DatabaseManager();