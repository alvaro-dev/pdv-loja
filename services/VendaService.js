const db = require('../database');
const crypto = require('crypto');

class VendaService {
    /**
     * Centraliza a inteligência analítica e as regras de negócio de uma venda antes da gravação física
     * @param {Object} dadosVenda Payload original vindo do front-end através do canal IPC
     */
    async validarERegistrarVenda(dadosVenda) {
        const { 
            caixaId, operadorId, total, formaPagamento, origem, 
            descricaoMovimento, bandeira, parcelas, clienteId 
        } = dadosVenda;

        // 1. Validações de Infraestrutura Básicas
        if (!caixaId || !operadorId) {
            throw new Error("Dados de infraestrutura inválidos: ID do Caixa ou do Operador ausentes.");
        }

        const valorVendaAtual = parseFloat(total || 0);
        if (isNaN(valorVendaAtual) || valorVendaAtual <= 0) {
            throw new Error("O valor total do lançamento deve ser maior que zero.");
        }

        // Normalização preventiva de variáveis do escopo de negócio
        let bandeiraTratada = bandeira;
        let parcelasTratadas = parseInt(parcelas) || 1;

        if (formaPagamento === 'CR') {
            bandeiraTratada = null; // Garantia arquitetural: Crediário nunca registra bandeira de cartão
        }

        // =====================================================================
        // 🛑 REGRA DE NEGÓCIO A: Obrigatoriedade de Cliente Nominal no Crediário (CR)
        // =====================================================================
        if (formaPagamento === 'CR') {
            if (!clienteId || clienteId === '00000000-0000-0000-0000-000000000000') {
                throw new Error("Vendas no Crediário exigem obrigatoriamente a identificação de um Cliente nominal.");
            }

            // Busca os dados do cliente de forma isolada na base local
            let dadosCliente = null;
            try {
                dadosCliente = await new Promise((resolve, reject) => {
                    db.sqliteDb.get(`SELECT nome, limite_credito FROM clientes_locais WHERE id = ?`, [clienteId], (err, row) => {
                        if (err) reject(err);
                        else resolve(row || null);
                    });
                });
            } catch (errCli) {
                console.error("[VendaService] Erro ao consultar limites do cliente no SQLite:", errCli.message);
                throw new Error("Falha ao validar cadastro do cliente na base do terminal.");
            }

            if (!dadosCliente) {
                throw new Error("Cliente selecionado não foi localizado na base de dados do terminal.");
            }

            // =====================================================================
            // 🛑 REGRA DE NEGÓCIO B: Validação e Checagem do Teto de Limite de Crédito
            // =====================================================================
            const tetoCadastrado = parseFloat(dadosCliente.limite_credito || 0);
            let totalDebitosAtuais = 0;

            // Checagem em tempo real dependendo do estado da rede (Híbrido via Repository)
            if (db.isOnline) {
                try {
                    // 🌟 MODIFICADO PARA USAR O REPOSITÓRIO DE CLIENTES
                    totalDebitosAtuais = await db.clientes.obterSaldoDevedorPostgres(clienteId);
                } catch (errPg) {
                    console.error("[VendaService] Falha ao consultar débitos online. Recuando para consulta local:", errPg.message);
                    db.isOnline = false; 
                }
            }

            if (!db.isOnline) {
                try {
                    // 🌟 MODIFICADO PARA USAR O REPOSITÓRIO DE CLIENTES
                    totalDebitosAtuais = await db.clientes.obterSaldoDevedorSQLite(clienteId);
                } catch (errLite) {
                    console.error("[VendaService] Erro ao buscar saldo devedor local:", errLite.message);
                }
            }

            const limiteDisponivel = tetoCadastrado - totalDebitosAtuais;

            if ((totalDebitosAtuais + valorVendaAtual) > tetoCadastrado) {
                throw new Error(`Limite Insuficiente: O cliente "${dadosCliente.nome}" possui teto de R$ ${tetoCadastrado.toFixed(2)}. Ele já possui R$ ${totalDebitosAtuais.toFixed(2)} em débitos em aberto na rede. Limite restante: R$ ${limiteDisponivel.toFixed(2)}. Esta nova compra totaliza R$ ${valorVendaAtual.toFixed(2)}.`);
            }
        }

        // 🚀 Tudo Validado! Delega exclusivamente a persistência física para a camada de banco de dados
        return await db.registrarVenda(
            caixaId, operadorId, valorVendaAtual, formaPagamento, origem, 
            descricaoMovimento, bandeiraTratada, parcelasTratadas, clienteId
        );
    }
}

module.exports = new VendaService();