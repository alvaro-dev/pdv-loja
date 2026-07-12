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

    /**
     * Busca o histórico global de turnos finalizados no PostgreSQL (Painel Administrativo)
     * Permite filtragem dinâmica por intervalo de timestamps locais
     */
    async obterHistoricoTurnosPostgres(dataInicio, dataFim) {
        let query = `
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

        if (dataInicio && dataFim) {
            parametros.push(`${dataInicio} 00:00:00`);
            parametros.push(`${dataFim} 23:59:59`);
            query += ` AND m.data_fechamento >= $1::timestamp AND m.data_fechamento <= $2::timestamp`;
        }

        query += ` ORDER BY m.data_fechamento DESC LIMIT 100`;

        const res = await this.db.pgClient.query(query, parametros);
        return res.rows;
    }

    /**
     * Extrai o extrato estrito e detalhado de lançamentos do turno no PostgreSQL
     * aplicando o isolamento baseado nas globais de governança (Tenant)
     */
    async obterVendasPorPeriodoPostgres(caixaId, dataInicio, dataFim, empresaId, filialId) {
        const query = `
            SELECT 
                v.origem, 
                v.total, 
                v.forma_pagamento, 
                v.descricao_movimento, 
                v.data_venda, 
                v.bandeira, 
                v.parcelas,
                COALESCE(c.nome, 'CONSUMIDOR FINAL') as cliente_nome
            FROM vendas v
            LEFT JOIN clientes c ON c.id = v.cliente_id
            WHERE v.caixa_id = $1 
              AND v.data_venda >= $2::timestamp
              AND v.data_venda <= $3::timestamp
              AND v.empresa_id = $4
              AND v.filial_id = $5
              AND v.deletado = false
            ORDER BY v.data_venda DESC
        `;
        const res = await this.db.pgClient.query(query, [caixaId, dataInicio, dataFim, empresaId, filialId]);
        return res.rows;
    }

    /**
     * Realiza a auditoria de contagem total e pendente de registros no SQLite local
     */
    async obterStatusSincronizacaoSQLite() {
        const tabelas = {
            vendas: 'vendas_locais',
            turnos: 'movimentos_caixa_locais',
            recebiveis: 'recebiveis_cartao_locais',
            crediario: 'contas_a_receber_locais'
        };
        const resultado = {};

        for (const [chave, nomeTabela] of Object.entries(tabelas)) {
            resultado[chave] = await new Promise((resolve) => {
                this.db.sqliteDb.get(
                    `SELECT COUNT(*) as total, SUM(CASE WHEN sincronizado = 0 THEN 1 ELSE 0 END) as pendentes FROM ${nomeTabela}`,
                    [],
                    (err, row) => {
                        if (err) resolve({ total: 0, pendentes: 0 });
                        else resolve({ total: row ? row.total : 0, pendentes: row ? (row.pendentes || 0) : 0 });
                    }
                );
            });
        }
        return resultado;
    }

    /**
     * Métodos auxiliares de coleta e atualização para a Sincronização Manual (SQLite)
     */
    async obterVendasPendentesManual() {
        return new Promise((resolve) => {
            this.db.sqliteDb.all(`SELECT * FROM vendas_locais WHERE sincronizado = 0`, [], (err, rows) => resolve(rows || []));
        });
    }

    async obterTurnosPendentesManual() {
        return new Promise((resolve) => {
            this.db.sqliteDb.all(`SELECT * FROM movimentos_caixa_locais WHERE sincronizado = 0`, [], (err, rows) => resolve(rows || []));
        });
    }

    async obterRecebiveisPendentesManual() {
        return new Promise((resolve) => {
            this.db.sqliteDb.all(`SELECT * FROM recebiveis_cartao_locais WHERE sincronizado = 0`, [], (err, rows) => resolve(rows || []));
        });
    }

    async obterCrediariosPendentesManual() {
        return new Promise((resolve) => {
            this.db.sqliteDb.all(`SELECT * FROM contas_a_receber_locais WHERE sincronizado = 0`, [], (err, rows) => resolve(rows || []));
        });
    }

    async obterMetadadosVendaPai(vendaId) {
        return new Promise((resolve) => {
            this.db.sqliteDb.get(`SELECT data_venda, parcelas FROM vendas_locais WHERE id = ?`, [vendaId], (err, row) => resolve(row || null));
        });
    }

    async obterIndiceOrdemParcela(vendaId, contaId) {
        return new Promise((resolve) => {
            this.db.sqliteDb.get(`SELECT COUNT(*) as indexador FROM contas_a_receber_locais WHERE venda_id = ? AND id <= ?`, [vendaId, contaId], (err, row) => resolve(row ? row.indexador : 1));
        });
    }

    /**
     * Busca os metadados cadastrais e de governança do caixa no SQLite local
     */
    async buscarCadastroLocal(caixaId) {
        return new Promise((resolve, reject) => {
            const query = 'SELECT id, descricao, empresa_id, filial_id FROM caixas_locais WHERE id = ? AND deletado = 0';
            this.db.sqliteDb.get(query, [caixaId], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    }

    /**
     * Busca os metadados cadastrais e de governança do caixa no PostgreSQL remoto
     */
    async buscarCadastroPostgres(caixaId) {
        const query = 'SELECT id, descricao, empresa_id, filial_id FROM caixas WHERE id = $1::uuid AND deletado = false';
        const resultado = await this.db.pgClient.query(query, [caixaId]);
        return resultado.rows.length > 0 ? resultado.rows[0] : null;
    }

    /**
     * Salva ou atualiza a carga de governança do caixa de forma síncrona no SQLite local
     */
    async salvarCargaLocal(caixa) {
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO caixas_locais (id, descricao, empresa_id, filial_id, deletado) 
                VALUES (?, ?, ?, ?, 0) 
                ON CONFLICT(id) DO UPDATE SET descricao = ?, empresa_id = ?, filial_id = ?
            `;
            this.db.sqliteDb.run(query, [
                caixa.id, caixa.descricao, caixa.empresa_id, caixa.filial_id,
                caixa.descricao, caixa.empresa_id, caixa.filial_id
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Busca todas as regras de escopo e governança configuradas globalmente no PostgreSQL remoto
     */
    async buscarEscoposTabelasPostgres() {
        const query = "SELECT tabela_nome, escopo FROM tabelas_escopo";
        const resultado = await this.db.pgClient.query(query);
        return resultado.rows;
    }

    /**
     * Atualiza a flag de sincronização de um turno específico no SQLite local
     */
    async marcarTurnoSincronizado(id) {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.run(
                `UPDATE movimentos_caixa_locais SET sincronizado = 1 WHERE id = ?`,
                [id],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }
}

module.exports = CaixaRepository;