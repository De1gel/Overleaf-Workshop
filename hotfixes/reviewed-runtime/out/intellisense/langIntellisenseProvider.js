"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LangIntellisenseProvider = void 0;
const vscode = require("vscode");
const consts_1 = require("../consts");
const texDocumentSymbolProvider_1 = require("./texDocumentSymbolProvider");
const texDocumentFormatProvider_1 = require("./texDocumentFormatProvider");
const langMisspellingCheckProvider_1 = require("./langMisspellingCheckProvider");
const langCompletionProvider_1 = require("./langCompletionProvider");
class LangIntellisenseProvider {
    constructor(context, vfsm) {
        this.vfsm = vfsm;
        const texSymbolProvider = new texDocumentSymbolProvider_1.TexDocumentSymbolProvider(vfsm);
        this.providers = [
            // document symbol provider
            texSymbolProvider,
            // document format provider
            new texDocumentFormatProvider_1.TexDocumentFormatProvider(vfsm),
            // completion provider
            new langCompletionProvider_1.CommandCompletionProvider(vfsm, context.extensionUri),
            new langCompletionProvider_1.ConstantCompletionProvider(vfsm, context.extensionUri),
            new langCompletionProvider_1.FilePathCompletionProvider(vfsm),
            new langCompletionProvider_1.ReferenceCompletionProvider(vfsm, texSymbolProvider),
            // misspelling check provider
            new langMisspellingCheckProvider_1.MisspellingCheckProvider(vfsm),
        ];
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
        const config = vscode.workspace.getConfiguration("cSpell");
        const setting = config.inspect("enabledSchemes");
        const enabledSchemes = config.get("enabledSchemes");
        if (setting && enabledSchemes?.[consts_1.ROOT_NAME] === undefined) {
            const globalSchemes = { ...setting.globalValue, [consts_1.ROOT_NAME]: true };
            void config.update("enabledSchemes", globalSchemes, vscode.ConfigurationTarget.Global)
                .then(undefined, () => console.warn("Could not enable CSpell for Overleaf documents"));
        }
        this.activate();
    }
    async activate() {
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme !== consts_1.ROOT_NAME) {
            return;
        }
        const vfs = uri && await this.vfsm.prefetch(uri);
        const languageItem = vfs?.getSpellCheckLanguage();
        if (languageItem) {
            const { name, code } = languageItem;
            this.status.text = code === '' ? '$(eye-closed)' : '$(eye) ' + code.toLocaleUpperCase();
            this.status.tooltip = new vscode.MarkdownString(`${vscode.l10n.t('Spell Check')}: **${name}**`);
            this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage spell check.')}*`);
        }
        else {
            this.status.text = '';
            this.status.tooltip = '';
        }
        this.status.command = 'langIntellisense.settings';
        this.status.show();
        setTimeout(this.activate.bind(this), 200);
    }
    get triggers() {
        return [
            // register provider triggers
            ...this.providers.map(x => x.triggers).flat(),
        ];
    }
}
exports.LangIntellisenseProvider = LangIntellisenseProvider;
//# sourceMappingURL=langIntellisenseProvider.js.map
