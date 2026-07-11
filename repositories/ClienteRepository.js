class ClienteRepository {
    constructor(dbManager) {
        // Recebe a instância do DatabaseManager para usar pgClient, sqliteDb e regras de escopo
        this.db = dbManager;
    }

    /**
     * Busca clientes locais no SQLite para o componente de autocomplete (PDV)
     */
    async buscarLocaisPorTermo(termo) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT id, nome, cpf, limite_credito, bloqueado 
                FROM clientes_locais 
                WHERE (nome LIKE ? OR cpf LIKE ?) AND deletado = 0
                LIMIT 10
            `;
            this.db.sqliteDb.all(query, [termo, termo], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    /**
     * Consulta a soma total de débitos pendentes de um cliente no PostgreSQL remoto
     */
    async obterSaldoDevedorPostgres(clienteId) {
        const query = `
            SELECT COALESCE(SUM(saldo_restante), 0) as total_devido 
            FROM contas_a_receber 
            WHERE cliente_id = $1::uuid AND status = 'P' AND deletado = false
        `;
        const res = await this.db.pgClient.query(query, [clienteId]);
        return parseFloat(res.rows[0].total_devido || 0);
    }

    /**
     * Consulta a soma total de débitos pendentes de um cliente no SQLite local (Contingência)
     */
    async obterSaldoDevedorSQLite(clienteId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT COALESCE(SUM(valor_original), 0) as total_devido 
                FROM contas_a_receber_locais 
                WHERE cliente_id = ? AND status = 'P' AND deletado = 0
            `;
            this.db.sqliteDb.get(query, [clienteId], (err, row) => {
                if (err) reject(err);
                else resolve(row ? (row.total_devido || 0) : 0);
            });
        });
    }

    /**
     * Retorna a última data de alteração da tabela de clientes locais (Sync incremental)
     */
    async obterUltimaAtualizacaoLocal() {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.get(`SELECT COALESCE(MAX(data_alteracao), '1970-01-01 00:00:00') as ultima FROM clientes_locais`, (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.ultima : '1970-01-01 00:00:00');
            });
        });
    }

    /**
     * Busca os clientes modificados no Postgres baseado nas regras de escopo de governança
     */
    async buscarModificadosPostgres(empresaId, filialId, ultimaAtualizacao, escopo) {
        let query = "";
        let parametros = [];

        if (escopo === 'COMPARTILHADO') {
            query = `
                SELECT 
                    c.id, c.empresa_id, c.filial_id, c.nome, c.cpf, c.bloqueado,
                    TO_CHAR(c.data_alteracao, 'YYYY-MM-DD HH24:MI:SS') as data_alteracao,
                    (COALESCE(c.limite_credito, 0) - COALESCE((SELECT SUM(saldo_restante) FROM contas_a_receber WHERE cliente_id = c.id AND status = 'P' AND deletado = false), 0)) as limite_restante
                FROM clientes c
                WHERE c.empresa_id = $1 AND c.filial_id IS NULL AND c.deletado = false AND DATE_TRUNC('second', c.data_alteracao) > $2::timestamp
            `;
            parametros = [empresaId, ultimaAtualizacao];
        } else {
            query = `
                SELECT 
                    c.id, c.empresa_id, c.filial_id, c.nome, c.cpf, c.bloqueado,
                    TO_CHAR(c.data_alteracao, 'YYYY-MM-DD HH24:MI:SS') as data_alteracao,
                    (COALESCE(c.limite_credito, 0) - COALESCE((SELECT SUM(saldo_restante) FROM contas_a_receber WHERE cliente_id = c.id AND status = 'P' AND deletado = false), 0)) as limite_restante
                FROM clientes c
                WHERE c.empresa_id = $1 AND c.filial_id = $2 AND c.deletado = false AND DATE_TRUNC('second', c.data_alteracao) > $3::timestamp
            `;
            parametros = [empresaId, filialId, ultimaAtualizacao];
        }

        const resultado = await this.db.pgClient.query(query, parametros);
        return resultado.rows;
    }

    /**
     * Salva ou atualiza um lote de clientes sincronizados de forma atômica no SQLite
     */
    async salvarLoteLocal(clientes) {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.serialize(() => {
                const stmt = this.db.sqliteDb.prepare(`
                    INSERT INTO clientes_locais (id, empresa_id, filial_id, nome, cpf, limite_credito, bloqueado, deletado, data_alteracao)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                    ON CONFLICT(id) DO UPDATE SET 
                        nome = excluded.nome, cpf = excluded.cpf, limite_credito = excluded.limite_credito, 
                        bloqueado = excluded.bloqueado, filial_id = excluded.filial_id, data_alteracao = excluded.data_alteracao
                `);

                for (const cli of clientes) {
                    const saldoDisponivel = parseFloat(cli.limite_restante || 0);
                    stmt.run([cli.id, cli.empresa_id, cli.filial_id, cli.nome, cli.cpf, saldoDisponivel, cli.bloqueado, cli.data_alteracao]);
                }

                stmt.finalize((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    }
}

module.exports = ClienteRepository;