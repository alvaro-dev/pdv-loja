const crypto = require('crypto');

class UsuarioRepository {
    constructor(dbManager) {
        // Recebe a instância do DatabaseManager para usar as conexões ativas pgClient e sqliteDb
        this.db = dbManager;
    }

    /**
     * Auxiliar: Gera o hash SHA-256 da senha
     */
    gerarHashSenha(senha) {
        return crypto.createHash('sha256').update(senha).digest('hex');
    }

    /**
     * Busca um usuário no PostgreSQL central
     */
    async buscarNoPostgres(usuario, senhaHash) {
        const query = `
            SELECT id, usuario, nome, role, bloqueado, trocar_senha_prox_login 
            FROM usuarios 
            WHERE usuario = $1 AND senha = $2 AND usuario_pdv = 'S' AND deletado = false
        `;
        const resultado = await this.db.pgClient.query(query, [usuario, senhaHash]);
        return resultado.rows.length > 0 ? resultado.rows[0] : null;
    }

    /**
     * Busca um usuário na contingência local SQLite
     */
    async buscarNoSQLite(usuario, senhaHash) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT id, usuario, nome, role, bloqueado 
                FROM usuarios_locais 
                WHERE usuario = ? AND senha = ? AND usuario_pdv = 'S' AND deletado = 0
            `;
            this.db.sqliteDb.get(query, [usuario, senhaHash], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    }

    /**
     * Sincroniza/Salva um operador unitário no SQLite local
     */
    async espelharOperadorLocal(operador, senhaHash) {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.run(
                `INSERT INTO usuarios_locais (id, usuario, nome, senha, role, bloqueado, usuario_pdv, trocar_senha_prox_login) 
                 VALUES (?, ?, ?, ?, ?, 'N', 'S', ?) 
                 ON CONFLICT(usuario) DO UPDATE SET nome=?, senha=?, role=?, trocar_senha_prox_login=?`,
                [operador.id, operador.usuario, operador.nome, senhaHash, operador.role, operador.trocar_senha_prox_login, operador.nome, senhaHash, operador.role, operador.trocar_senha_prox_login],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    /**
     * Trava A: Verifica se o caixa possui turno ativo de outro operador (Postgres)
     */
    async obterDonoTurnoAtivoPostgres(caixaId) {
        const query = `
            SELECT m.operador_abertura_id, o.nome AS dono_nome 
            FROM movimentos_caixa m
            JOIN usuarios o ON o.id = m.operador_abertura_id AND o.deletado = false
            WHERE m.caixa_id = $1::uuid m.status = 'A' AND m.deletado = false
            LIMIT 1
        `;
        const res = await this.db.pgClient.query(query, [caixaId]);
        return res.rows.length > 0 ? res.rows[0] : null;
    }

    /**
     * Trava A: Verifica se o caixa possui turno ativo de outro operador (SQLite)
     */
    async obterDonoTurnoAtivoSQLite(caixaId) {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.get(
                `SELECT m.operador_abertura_id, 'Outro Operador (Offline)' AS dono_nome 
                 FROM movimentos_caixa_locais m 
                 WHERE m.caixa_id = ? AND m.status = 'A' AND m.deletado = 0`,
                [caixaId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    /**
     * Trava B: Verifica se o operador já tem outro caixa aberto (Postgres)
     */
    async obterCaixaAbertoPorOperadorPostgres(operadorId) {
        const query = `
            SELECT m.id, c.descricao AS caixa_nome, c.id AS cod_caixa
            FROM movimentos_caixa m
            JOIN caixas c ON c.id = m.caixa_id AND c.deletado = false
            WHERE m.operador_abertura_id = $1 AND m.status = 'A' AND m.deletado = false
            LIMIT 1
        `;
        const res = await this.db.pgClient.query(query, [operadorId]);
        return res.rows.length > 0 ? res.rows[0] : null;
    }

    /**
     * Trava B: Verifica se o operador já tem outro caixa aberto (SQLite)
     */
    async obterCaixaAbertoPorOperadorSQLite(operadorId) {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.get(
                `SELECT m.id, 'outro terminal (Offline)' AS caixa_nome, c.id AS cod_caixa 
                 FROM movimentos_caixa_locais m 
                 JOIN caixas_locais c ON c.id = m.caixa_id AND c.deletado = 0
                 WHERE m.operador_abertura_id = ? AND m.status = 'A' AND m.deletado = 0`,
                [operadorId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    /**
     * Retorna a última data de alteração dos usuários locais
     */
    async obterUltimaAtualizacaoLocal() {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.get(`SELECT COALESCE(MAX(data_alteracao), '1970-01-01 00:00:00') as ultima FROM usuarios_locais`, (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.ultima : '1970-01-01 00:00:00');
            });
        });
    }

    /**
     * Busca usuários modificados no Postgres para o Sync incremental
     */
    async buscarModificadosPostgres(empresaId, filialId, ultimaAtualizacao) {
        const query = `
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
        const resultado = await this.db.pgClient.query(query, [empresaId, filialId, ultimaAtualizacao]);
        return resultado.rows;
    }

    /**
     * Salva um lote de operadores de forma transacionada no SQLite
     */
    async salvarLoteLocal(operadores) {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.serialize(() => {
                const stmt = this.db.sqliteDb.prepare(`
                    INSERT INTO usuarios_locais (id, usuario, nome, senha, role, bloqueado, usuario_pdv, trocar_senha_prox_login, data_alteracao)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(usuario) DO UPDATE SET 
                        id = excluded.id, nome = excluded.nome, senha = excluded.senha, role = excluded.role, 
                        bloqueado = excluded.bloqueado, usuario_pdv = excluded.usuario_pdv, 
                        trocar_senha_prox_login = excluded.trocar_senha_prox_login, data_alteracao = excluded.data_alteracao
                `);

                for (const op of operadores) {
                    stmt.run([op.id, op.usuario, op.nome, op.senha, op.role, op.bloqueado, op.usuario_pdv, op.trocar_senha_prox_login, op.data_alteracao]);
                }

                stmt.finalize((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    }
}

module.exports = UsuarioRepository;