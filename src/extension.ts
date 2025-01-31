import * as vscode from 'vscode';
import { exec } from 'child_process';

class ErrorsWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'debugmate-errors';
    private _view?: vscode.WebviewView;
    private errorBuffer: string[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        this.updateContent([]);
    }

    public updateContent(errors: string[]) {
        if (this._view) {
            this._view.webview.html = getWebviewContent(errors);
        }
    }

    public addError(error: string) {
        this.errorBuffer.push(error);
        this.updateContent(this.errorBuffer);
    }

    public clearErrors() {
        this.errorBuffer = [];
        this.updateContent([]);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new ErrorsWebviewProvider(context.extensionUri);
    
    // Registrar o provedor de webview
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ErrorsWebviewProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Comando para mostrar a view
    context.subscriptions.push(
        vscode.commands.registerCommand('debugmate-errors.focus', () => {
            vscode.commands.executeCommand('workbench.view.extension.debugmate-explorer');
        })
    );

    // Monitor de terminal melhorado
    let terminalDataBuffer = '';
    let isCollectingTraceback = false;
    let tracebackBuffer: string[] = [];
    context.subscriptions.push(
        vscode.window.onDidWriteTerminalData(e => {
            const data = e.data;
            terminalDataBuffer += data;

            // Processa o buffer quando encontra caracteres de nova linha
            if (terminalDataBuffer.includes('\n')) {
                const lines = terminalDataBuffer.split('\n');
                terminalDataBuffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();

                    if (trimmedLine.includes('Traceback (most recent call last)')) {
                        isCollectingTraceback = true;
                        tracebackBuffer = [trimmedLine];
                        continue;
                    }

                    if (isCollectingTraceback) {
                        tracebackBuffer.push(trimmedLine);

                        // Verifica se é a última linha do traceback (linha do erro)
                        if (trimmedLine.match(/^\w+Error:/)) {
                            isCollectingTraceback = false;
                            const fullTraceback = tracebackBuffer.join('\n');
                            provider.addError(fullTraceback);
                            tracebackBuffer = [];
                            vscode.commands.executeCommand('debugmate-errors.focus');
                        }
                        continue;
                    }

                    // Para outras linhas de erro não relacionadas a traceback
                    if (isErrorLine(trimmedLine)) {
                        provider.addError(trimmedLine);
                        vscode.commands.executeCommand('debugmate-errors.focus');
                    }
                }
            }
        })
    );

    // Comando para limpar erros
    context.subscriptions.push(
        vscode.commands.registerCommand('debugmate-errors.clear', () => {
            provider.clearErrors();
        })
    );

    let disposable = vscode.commands.registerCommand('extension.captureErrors', () => {
        const terminal = vscode.window.activeTerminal;
        if (!terminal) {
            vscode.window.showErrorMessage('Nenhum terminal ativo encontrado.');
            return;
        }

        // Primeiro, mostrar a view de erros
        vscode.commands.executeCommand('debugmate-errors.focus');

        terminal.processId.then((pid) => {
            if (pid) {
                const process = require('child_process');
                process.exec(`ps -o args= -p ${pid}`, (err: any, stdout: any, stderr: any) => {
                    if (err) {
                        vscode.window.showErrorMessage('Falha ao capturar a saída do terminal.');
                        return;
                    }
                    const output = stdout.toString();
                    const errors = extractErrors(output);
                    if (errors.length > 0) {
                        provider.updateContent(errors);
                    } else {
                        vscode.window.showInformationMessage('Nenhum erro encontrado na saída do terminal.');
                    }
                });
            }
        });
    });

    context.subscriptions.push(disposable);

    // Registre o comando para capturar erros do sistema
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.captureSystemErrors', () => {
            captureSystemErrors(provider);
        })
    );
}

interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    raw: string;
    errorType?: string;  // Novo campo para tipo de erro
    filepath?: string;   // Novo campo para caminho do arquivo
}

function parseLogLine(line: string): LogEntry | null {
    // Detectar início de traceback Python
    if (line.includes('Traceback (most recent call last)')) {
        return {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: line,
            raw: line,
            errorType: 'Python Traceback'
        };
    }

    // Detectar erro Python específico
    const pythonErrorMatch = line.match(/^(\w+Error):\s+(.+)$/);
    if (pythonErrorMatch) {
        return {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: pythonErrorMatch[2],
            raw: line,
            errorType: pythonErrorMatch[1]
        };
    }

    // Primeiro tenta parsear erros do Python
    const pythonErrorPattern = /^python:\s+(.+?):\s+\[(.*?)\]\s+(.+)$/i;
    const pythonMatches = line.match(pythonErrorPattern);
    
    if (pythonMatches) {
        return {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            errorType: pythonMatches[2],
            message: pythonMatches[3],
            raw: line,
            filepath: pythonMatches[1]
        };
    }

    // Regex para logs com timestamp ISO/custom
    const logPattern = /^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\s+(INFO|WARNING|ERROR|DEBUG|CRITICAL)\s+(.+)$/i;
    const matches = line.match(logPattern);
    
    if (matches) {
        return {
            timestamp: matches[1],
            level: matches[2].toUpperCase(),
            message: matches[3],
            raw: line
        };
    }
    return null;
}

function isErrorLine(line: string): boolean {
    // Adicionar padrões específicos para Python
    const pythonPatterns = [
        /^Traceback \(most recent call last\):/i,
        /^\s*File ".*", line \d+/i,
        /^\w+Error:/,
        /^\w+Exception:/,
        /^SyntaxError:/,
        /^IndentationError:/,
        /^NameError:/,
        /^TypeError:/,
        /^ValueError:/
    ];

    if (pythonPatterns.some(pattern => pattern.test(line))) {
        return true;
    }

    // Primeiro tenta parser como log estruturado
    const logEntry = parseLogLine(line);
    if (logEntry) {
        return logEntry.level === 'ERROR' || logEntry.level === 'CRITICAL';
    }

    // Padrões de erro mais abrangentes
    const errorPatterns = [
        /erro/i,
        /error/i,
        /fail/i,
        /falha/i,
        /exception/i,
        /traceback/i,
        /fatal/i,
        /warning/i,
        /undefined/i,
        /null/i,
        /cannot/i,
        /não\s+encontrado/i,
        /not\s+found/i,
        /invalid/i,
        /inválido/i
    ];
    
    return errorPatterns.some(pattern => pattern.test(line));
}

function extractErrors(output: string): string[] {
    const errorPatterns = [/error/gi, /fail/gi];
    return output.split('\n').filter(line => {
        return errorPatterns.some(pattern => pattern.test(line));
    });
}

function getWebviewContent(errors: string[]): string {
    return `
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <style>
                body { 
                    padding: 15px; 
                    font-family: var(--vscode-font-family);
                }
                .error-card {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 12px;
                    margin-bottom: 12px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                .error-text {
                    color: var(--vscode-errorForeground);
                    margin: 0;
                    white-space: pre-wrap;
                    word-break: break-word;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                }
                .timestamp {
                    color: var(--vscode-descriptionForeground);
                    font-size: 0.8em;
                    margin-top: 4px;
                }
                .toolbar {
                    margin-bottom: 15px;
                    display: flex;
                    gap: 8px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 2px;
                    cursor: pointer;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .log-entry {
                    display: grid;
                    grid-template-columns: auto 1fr;
                    gap: 8px;
                }
                .log-timestamp {
                    color: var(--vscode-textPreformat-foreground);
                    font-family: var(--vscode-editor-font-family);
                    white-space: nowrap;
                }
                .log-level {
                    display: inline-block;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-weight: bold;
                    margin-right: 8px;
                }
                .log-level.error {
                    background-color: var(--vscode-errorForeground);
                    color: var(--vscode-editor-background);
                }
                .log-level.warning {
                    background-color: var(--vscode-warningForeground);
                    color: var(--vscode-editor-background);
                }
                .error-type {
                    color: var(--vscode-textLink-foreground);
                    font-size: 0.9em;
                    margin-bottom: 4px;
                }
                .filepath {
                    font-family: var(--vscode-editor-font-family);
                    color: var(--vscode-textPreformat-foreground);
                    background: var(--vscode-textBlockQuote-background);
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-size: 0.9em;
                }
            </style>
        </head>
        <body>
            <div class="toolbar">
                <button onclick="clearErrors()">Limpar Erros</button>
                ${errors.length > 0 ? `<button onclick="sendErrorsToCopilot()">Analisar com Copilot</button>` : ''}
            </div>
            <div id="errors-container">
                ${errors.length > 0 ? 
                    errors.map(error => {
                        const logEntry = parseLogLine(error);
                        if (logEntry) {
                            return `
                                <div class="error-card">
                                    <div class="log-entry">
                                        ${logEntry.errorType ? 
                                            `<div class="error-type">
                                                ${logEntry.errorType}
                                                ${logEntry.filepath ? 
                                                    `<span class="filepath">${logEntry.filepath}</span>` 
                                                    : ''
                                                }
                                            </div>` 
                                            : ''
                                        }
                                        <span class="error-text">${logEntry.message}</span>
                                    </div>
                                    <div class="timestamp">${new Date(logEntry.timestamp).toLocaleTimeString()}</div>
                                </div>
                            `;
                        } else {
                            return `
                                <div class="error-card">
                                    <pre class="error-text">${error}</pre>
                                </div>
                            `;
                        }
                    }).join('') 
                    : '<p>Nenhum erro encontrado</p>'
                }
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                function sendErrorsToCopilot() {
                    vscode.postMessage({
                        command: 'sendErrors',
                        errors: ${JSON.stringify(errors)}
                    });
                }
                function clearErrors() {
                    vscode.postMessage({
                        command: 'clearErrors'
                    });
                }
            </script>
        </body>
        </html>
    `;
}

function captureSystemErrors(provider: ErrorsWebviewProvider) {
    const platform = process.platform;
    
    if (platform === 'linux' || platform === 'darwin') {
        // Captura logs do sistema
        exec('journalctl -n 50 -p err', (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Erro ao capturar logs: ${error.message}`);
                return;
            }
            
            // Processa os erros encontrados
            const errors = stdout.split('\n')
                .filter(line => line.trim().length > 0)
                .map(line => line.trim());
                
            // Adiciona os erros à visualização
            if (errors.length > 0) {
                provider.updateContent(errors);
            } else {
                vscode.window.showInformationMessage('Nenhum erro encontrado nos logs do sistema.');
            }
        });
    }
}