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

    /**
     * Busca os metadados do turno ativo ('A') no PostgreSQL remoto
     */
    async obterMovimentoAtivoPostgres(caixaId) {
        const query = `SELECT id, valor_abertura, data_abertura FROM movimentos_caixa WHERE caixa_id = $1::uuid AND status = 'A' AND deletado = false LIMIT 1`;
        const res = await this.db.pgClient.query(query, [caixaId]);
        return res.rows.length > 0 ? res.rows[0] : null;
    }

    /**
     * Busca os metadados do turno ativo ('A') no SQLite local
     */
    async obterMovimentoAtivoSQLite(caixaId) {
        return new Promise((resolve, reject) => {
            const query = `SELECT id, valor_abertura, data_abertura FROM movimentos_caixa_locais WHERE caixa_id = ? AND status = 'A' AND deletado = 0`;
            this.db.sqliteDb.get(query, [caixaId], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    }

    /**
     * Busca todas as vendas e movimentações financeiras de um período específico no PostgreSQL
     */
    async listarVendasParaResumoPostgres(caixaId, dataAbertura) {
        const query = `
            SELECT origem, total, forma_pagamento FROM vendas 
            WHERE caixa_id = $1::uuid AND data_venda >= $2::timestamp AND deletado = false
        `;
        const res = await this.db.pgClient.query(query, [caixaId, dataAbertura]);
        return res.rows;
    }

    /**
     * Busca todas as vendas e movimentações financeiras de um período específico no SQLite local
     */
    async listarVendasParaResumoSQLite(caixaId, dataAbertura) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT origem, total, forma_pagamento FROM vendas_locais 
                WHERE caixa_id = ? AND data_venda >= ? AND deletado = 0
            `;
            this.db.sqliteDb.all(query, [caixaId, dataAbertura], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    /**
     * Atualiza o status e os valores de auditoria do fechamento de caixa no PostgreSQL
     */
    async atualizarFechamentoPostgres(dados, dataFechamento) {
        const query = `
            UPDATE movimentos_caixa 
            SET status = 'F', data_fechamento = $1::timestamp, operador_fechamento_id = $2::uuid, 
                valor_fechamento = $3, valor_contado = $4, diferenca = $5
            WHERE id = $6::uuid
        `;
        await this.db.pgClient.query(query, [
            dataFechamento, dados.operadorFechamentoId, dados.valorFechamento, 
            dados.valorContado, dados.diferenca, dados.movimentoId
        ]);
    }

    /**
     * Atualiza o status e os valores de auditoria do fechamento de caixa no SQLite local
     */
    async atualizarFechamentoSQLite(dados, dataFechamento, jaSincronizado) {
        return new Promise((resolve, reject) => {
            const query = `
                UPDATE movimentos_caixa_locais 
                SET status = 'F', data_fechamento = ?, operador_fechamento_id = ?, 
                    valor_fechamento = ?, valor_contado = ?, diferenca = ?, sincronizado = ?
                WHERE id = ?
            `;
            this.db.sqliteDb.run(query, [
                dataFechamento, dados.operadorFechamentoId, dados.valorFechamento, 
                dados.valorContado, dados.diferenca, jaSincronizado, dados.movimentoId
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = CaixaRepository;