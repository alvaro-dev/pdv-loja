const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

class ConfigService {
    constructor() {
        this.caminhoConfig = path.join(app.getPath('userData'), 'config.json');
    }

    /**
     * Garante a existência do arquivo básico e lê o caixaId
     */
    obterCaixaId() {
        try {
            if (fs.existsSync(this.caminhoConfig)) {
                const config = JSON.parse(fs.readFileSync(this.caminhoConfig, 'utf8'));
                return config.caixaId || null;
            } else {
                fs.writeFileSync(this.caminhoConfig, JSON.stringify({ caixaId: "" }, null, 2));
                return null;
            }
        } catch (err) {
            console.error("[ConfigService] Erro ao ler caixaId:", err);
            return null;
        }
    }

    /**
     * Atualiza o caixaId no arquivo de configuração
     */
    atualizarCaixaId(novoCaixaId) {
        let config = this._lerArquivo();
        config.caixaId = String(novoCaixaId || '').trim();
        this._gravarArquivo(config);
    }

    /**
     * Criptografa e grava dados de um domínio genérico (Banco ou Operador)
     */
    salvarPropriedadeCriptografada(chave, objetoDados) {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("Criptografia nativa do S.O. indisponível.");
        }
        let config = this._lerArquivo();
        const stringDados = JSON.stringify(objetoDados);
        const buffer = safeStorage.encryptString(stringDados);
        
        config[chave] = buffer.toString('hex');
        this._gravarArquivo(config);
    }

    /**
     * Descriptografa e recupera dados de um domínio genérico
     */
    recuperarPropriedadeCriptografada(chave) {
        let config = this._lerArquivo();
        if (!config || !config[chave]) return null;

        if (!safeStorage.isEncryptionAvailable()) {
            console.error(`[ConfigService] safeStorage indisponível para ler: ${chave}`);
            return null;
        }

        const buffer = Buffer.from(config[chave], 'hex');
        const stringDescriptografada = safeStorage.decryptString(buffer);
        return JSON.parse(stringDescriptografada);
    }

    /**
     * Remove chaves específicas do arquivo
     */
    removerPropriedades(chavesArray) {
        let config = this._lerArquivo();
        chavesArray.forEach(k => delete config[k]);
        this._gravarArquivo(config);
    }

    // Métodos privados utilitários
    _lerArquivo() {
        if (!fs.existsSync(this.caminhoConfig)) return {};
        try {
            return JSON.parse(fs.readFileSync(this.caminhoConfig, 'utf8'));
        } catch { return {}; }
    }

    _gravarArquivo(objeto) {
        fs.writeFileSync(this.caminhoConfig, JSON.stringify(objeto, null, 2));
    }
}

module.exports = new ConfigService();