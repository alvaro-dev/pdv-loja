class VendaRepository {
    constructor(dbManager) {
        this.db = dbManager;
    }

    /**
     * Insere o cabeçalho de uma venda na tabela local SQLite
     */
    async inserirVendaPaiSQLite(venda) {
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO vendas_locais (id, caixa_id, operador_id, cliente_id, forma_pagamento, origem, total, descricao_movimento, data_venda, sincronizado, deletado, bandeira, parcelas) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
            `;
            this.db.sqliteDb.run(query, [
                venda.id, venda.caixaId, venda.operadorId, venda.clienteId, 
                venda.formaPagamento, venda.origem, venda.total, 
                venda.descricaoMovimento, venda.dataVenda, venda.bandeira, venda.parcelas
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Insere uma parcela de crediário na tabela local SQLite
     */
    async inserirParcelaCrediarioSQLite(parcela) {
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO contas_a_receber_locais (id, venda_id, cliente_id, data_vencimento, valor_original, status, sincronizado, deletado)
                VALUES (?, ?, ?, ?, ?, 'P', 0, 0)
            `;
            this.db.sqliteDb.run(query, [
                parcela.id, parcela.vendaId, parcela.clienteId, 
                parcela.dataVencimento, parcela.valorOriginal
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Insere uma parcela de recebível de cartão na tabela local SQLite
     */
    async inserirParcelaCartaoSQLite(recebivel) {
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO recebiveis_cartao_locais (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, sincronizado, deletado)
                VALUES (?, ?, ?, ?, ?, ?, 'P', 0, 0)
            `;
            this.db.sqliteDb.run(query, [
                recebivel.id, recebivel.vendaId, recebivel.caixaId, 
                recebivel.parcelaNumero, recebivel.valorParcela, recebivel.dataPrevista
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Replica a venda pai de forma estrita no PostgreSQL remoto
     */
    async inserirVendaPaiPostgres(venda, empresaId, filialId) {
        const query = `
            INSERT INTO vendas (id, caixa_id, operador_id, cliente_id, forma_pagamento, origem, total, descricao_movimento, data_venda, bandeira, parcelas, empresa_id, filial_id) 
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::timestamp, $10, $11, $12::uuid, $13::uuid)
        `;
        await this.db.pgClient.query(query, [
            venda.id, venda.caixaId, venda.operadorId, venda.clienteId, 
            venda.formaPagamento, venda.origem, venda.total, 
            venda.descricaoMovimento, venda.dataVenda, venda.bandeira, 
            venda.parcelas, empresaId, filialId
        ]);
    }

    /**
     * Recupera parcelas locais de uma venda para upload remoto
     */
    async obterContasReceberLocaisPorVenda(vendaId) {
        return new Promise((resolve) => {
            this.db.sqliteDb.all(`SELECT * FROM contas_a_receber_locais WHERE venda_id = ?`, [vendaId], (err, rows) => resolve(rows || []));
        });
    }

    /**
     * Replicar parcela de crediário no PostgreSQL remoto garantindo integridade de valores
     */
    async inserirContaReceberPostgres(conta, nrParcela, totalParcelas, dataEmissao, empresaId, filialId) {
        const query = `
            INSERT INTO contas_a_receber (
                id, empresa_id, filial_id, venda_id, cliente_id, 
                parcela_numero, total_parcelas, data_emissao, data_vencimento, 
                valor_original, valor_juros, valor_multa, valor_pago, saldo_restante, 
                status, deletado
            )
            VALUES (
                $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 
                $6, $7, $8::timestamp, $9::date, 
                $10, 0.00, 0.00, 0.00, $11, 
                'P', false
            )
            ON CONFLICT (id) DO UPDATE SET status = excluded.status
        `;

        // Garante a leitura independente das chaves vinda de queries locais SQLite (data_vencimento vs dataVencimento)
        const vencimento = conta.data_vencimento || conta.dataVencimento;
        const valorOriginal = parseFloat(conta.valor_original || conta.valorOriginal || 0);

        await this.db.pgClient.query(query, [
            conta.id,
            empresaId,
            filialId,
            conta.venda_id || conta.vendaId,
            conta.cliente_id || conta.clienteId,
            nrParcela,
            totalParcelas,
            dataEmissao,
            vencimento,
            valorOriginal, // $10 -> valor_original
            valorOriginal  // $11 -> saldo_restante
        ]);
    }

    /**
     * Marcar parcela de crediário local como sincronizada
     */
    marcarContaReceberSincronizada(id) {
        this.db.sqliteDb.run(`UPDATE contas_a_receber_locais SET sincronizado = 1 WHERE id = ?`, [id]);
    }

    /**
     * Recupera parcelas locais de cartão de uma venda para upload remoto
     */
    async obterRecebiveisCartaoLocaisPorVenda(vendaId) {
        return new Promise((resolve) => {
            this.db.sqliteDb.all(`SELECT * FROM recebiveis_cartao_locais WHERE venda_id = ?`, [vendaId], (err, rows) => resolve(rows || []));
        });
    }

    /**
     * Replicar parcela de cartão no PostgreSQL remoto
     */
    async inserirRecebivelCartaoPostgres(rec, empresaId, filialId) {
        const query = `
            INSERT INTO recebiveis_cartao (id, venda_id, caixa_id, parcela_numero, valor_parcela, data_prevista_recebimento, status, deletado, empresa_id, filial_id) 
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamp, 'P', $7::boolean, $8::uuid, $9::uuid)
            ON CONFLICT (id) DO UPDATE SET status = excluded.status, deletado = excluded.deletado
        `;
        await this.db.pgClient.query(query, [
            rec.id, rec.venda_id || rec.vendaId, rec.caixa_id || rec.caixaId, 
            rec.parcela_numero || rec.parcelaNumero, rec.valor_parcela || rec.valorParcela, 
            rec.data_prevista_recebimento || rec.dataPrevista, rec.deletado === 1, empresaId, filialId
        ]);
    }

    /**
     * Marcar recebível de cartão local como sincronizado
     */
    marcarRecebivelCartaoSincronizado(id) {
        this.db.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET sincronizado = 1 WHERE id = ?`, [id]);
    }

    /**
     * Marcar o cabeçalho da venda local como sincronizado
     */
    marcarVendaSincronizada(id) {
        this.db.sqliteDb.run(`UPDATE vendas_locais SET sincronizado = 1 WHERE id = ?`, [id]);
    }

    /**
     * Busca todas as vendas não sincronizadas do SQLite local
     */
    async obterVendasLocaisPendentes() {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.all(`SELECT * FROM vendas_locais WHERE sincronizado = 0`, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    /**
     * Executa soft-delete de vendas no PostgreSQL remoto
     */
    async marcarDeletadaPostgres(vendaId) {
        await this.db.pgClient.query(`UPDATE vendas SET deletado = true WHERE id = $1::uuid`, [vendaId]);
        await this.db.pgClient.query(`UPDATE recebiveis_cartao SET deletado = true WHERE venda_id = $1::uuid`, [vendaId]);
    }

    /**
     * Executa soft-delete de vendas transacionadas no SQLite local
     */
    async marcarDeletadaLocal(vendaId, jaSincronizado) {
        return new Promise((resolve, reject) => {
            this.db.sqliteDb.serialize(() => {
                this.db.sqliteDb.run("BEGIN TRANSACTION");
                this.db.sqliteDb.run(`UPDATE vendas_locais SET deletado = 1, sincronizado = ? WHERE id = ?`, [jaSincronizado, vendaId]);
                this.db.sqliteDb.run(`UPDATE recebiveis_cartao_locais SET deletado = 1, sincronizado = ? WHERE venda_id = ?`, [jaSincronizado, vendaId]);
                this.db.sqliteDb.run("COMMIT", (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    }

    /**
     * Consulta o histórico de lançamentos do turno ativo no PostgreSQL central
     */
    async listarVendasTurnoPostgres(caixaId, dataAbertura) {
        const query = `
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
        const res = await this.db.pgClient.query(query, [caixaId, dataAbertura]);
        return res.rows;
    }

    /**
     * Consulta o histórico de lançamentos do turno ativo no SQLite local (Contingência)
     */
    async listarVendasTurnoSQLite(caixaId, dataAbertura) {
        return new Promise((resolve) => {
            const query = `
                SELECT 
                    v.id, v.origem, v.total, v.forma_pagamento, v.descricao_movimento, v.bandeira, v.parcelas, 
                    COALESCE(c.nome, 'CONSUMIDOR FINAL') as cliente_nome 
                FROM vendas_locais v 
                LEFT JOIN clientes_locais c ON c.id = v.cliente_id 
                WHERE v.caixa_id = ? AND v.data_venda >= ? AND v.deletado = 0 
                ORDER BY v.data_venda DESC
            `;
            this.db.sqliteDb.all(query, [caixaId, dataAbertura], (err, rows) => {
                if (err) {
                    console.error("[VendaRepository] Erro ao listar vendas localmente:", err.message);
                    resolve([]);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }
}

module.exports = VendaRepository;