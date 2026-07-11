class CaixaRepository {
    constructor(dbManager) {
        this.db = dbManager;
    }

    /**
     * Verifica na nuvem (Postgres) se existe um turno ativo ('A') para o caixa
     */
    async verificarTurnoAbertoPostgres(caixaId) {
        const query = `SELECT id FROM movimentos_caixa WHERE caixa_id = $1::uuid AND status = 'A' AND deletado = false LIMIT 1`;
        const res = await this.db.pgClient.query(query, [caixaId]);
        return res.rows.length > 0;
    }

    /**
     * Verifica na contingência (SQLite) se existe um turno ativo ('A') para o caixa
     */
    async verificarTurnoAbertoSQLite(caixaId) {
        return new Promise((resolve) => {
            const query = `SELECT id FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A' AND deletado = 0`;
            this.db.sqliteDb.get(query, [caixaId], (err, row) => {
                if (err) resolve(false);
                else resolve(!!row);
            });
        });
    }

    /**
     * Insere um novo registro de abertura de turno no PostgreSQL remoto
     */
    async inserirAberturaPostgres(movimento, empresaId, filialId) {
        const query = `
            INSERT INTO movimentos_caixa (id, caixa_id, operador_abertura_id, data_abertura, valor_abertura, status, empresa_id, filial_id)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamp, $5, $6, $7::uuid, $8::uuid)
        `;
        await this.db.pgClient.query(query, [
            movimento.id, movimento.caixaId, movimento.operadorId, 
            movimento.dataAbertura, movimento.valorAbertura, 'A', empresaId, filialId
        ]);
    }

    /**
     * Insere um novo registro de abertura de turno no SQLite local
     */
    async inserirAberturaSQLite(movimento, jaSincronizado) {
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO movimentos_caixa_locais (id, caixa_id, operador_abertura_id, data_abertura, valor_abertura, status, sincronizado) 
                VALUES (?, ?, ?, ?, ?, 'A', ?)
            `;
            this.db.sqliteDb.run(query, [
                movimento.id, movimento.caixaId, movimento.operadorId, 
                movimento.dataAbertura, movimento.valorAbertura, jaSincronizado
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = CaixaRepository;