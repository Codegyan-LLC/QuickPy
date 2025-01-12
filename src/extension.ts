import { exec } from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let currentDecorationType: vscode.TextEditorDecorationType | undefined;
let errorDecorationType: vscode.TextEditorDecorationType | undefined;
let timeout: NodeJS.Timeout | undefined;

// Default configuration
const defaultConfig = {
	executionDelay: 300,    // Delay in milliseconds before executing code
    pythonPath: 'python3',
    inlineColor: 'grey',
};

function activate(context: vscode.ExtensionContext) {
    // Subscribe to text document and selection change events
    const textChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
            updateOutput(editor);
        }
    });

    const selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
        const editor = event.textEditor;
        updateOutput(editor);
    });

    // Register a command to execute a selected block of code
    const blockExecutionDisposable = vscode.commands.registerCommand('pythonLiveExecution.runBlock', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            runSelectedBlock(editor);
        }
    });

    context.subscriptions.push(textChangeDisposable, selectionChangeDisposable, blockExecutionDisposable);
}

function updateOutput(editor: vscode.TextEditor) {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
        const currentLine = editor.selection.active.line;
        const currentLineText = editor.document.lineAt(currentLine).text.trim();
        if (
            (currentLineText.startsWith('print(') ||
                (/\w+\s*\(.*\)/.test(currentLineText) && !currentLineText.startsWith('def '))) &&
            !currentLineText.startsWith('for ') &&
            !currentLineText.startsWith('while ') &&
            !currentLineText.startsWith('if ') &&
            !currentLineText.startsWith('elif ') &&
            !currentLineText.startsWith('else:')
        ) {
            const documentText = editor.document.getText();
            runPythonCode(documentText, editor, currentLine);
        } else {
            clearOutput(editor);
        }
    }, defaultConfig.executionDelay);
}

function clearOutput(editor: vscode.TextEditor) {
    if (currentDecorationType) {
        editor.setDecorations(currentDecorationType, []);
        currentDecorationType.dispose();
        currentDecorationType = undefined;
    }

    if (errorDecorationType) {
        editor.setDecorations(errorDecorationType, []);
        errorDecorationType.dispose();
        errorDecorationType = undefined;
    }
}

function runPythonCode(code: string, editor: vscode.TextEditor, currentLine: number) {
    const lines = code.split('\n');
    const currentLineText = lines[currentLine].trim();
    if (!currentLineText) {
        return;
    }

    // Prepare the code to execute
    const codeToExecute = lines.slice(0, currentLine + 1).join('\n') + '\n';
    const tempFilePath = path.join(__dirname, 'cg.py');
    fs.writeFileSync(tempFilePath, codeToExecute);

    const pythonPath =
        vscode.workspace.getConfiguration('pythonLiveExecution').get<string>('pythonPath') || defaultConfig.pythonPath;

    const startTime = Date.now();

    exec(`${pythonPath} "${tempFilePath}"`, (error, stdout, stderr) => {
        const endTime = Date.now();
        const executionTime = ((endTime - startTime) / 1000).toFixed(2);

        if (error || stderr) {
			// Clear any existing decorations before applying new ones
			clearOutput(editor);
            const errorMessage = stderr || (error ? error.message : 'Unknown error');
            displayInlineOutput(`Error: ${errorMessage.trim()}`, editor, currentLine, executionTime, true);
        } else {
			clearOutput(editor);
            const outputLines = stdout.trim().split('\n');
            const lastOutput = outputLines[outputLines.length - 1];
            displayInlineOutput(lastOutput, editor, currentLine, executionTime);
        }

        // Clean up the temporary file
        fs.unlinkSync(tempFilePath);
    });
}

function runSelectedBlock(editor: vscode.TextEditor) {
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);

    if (!selectedText.trim()) {
        vscode.window.showErrorMessage('No code selected to execute.');
        return;
    }

    const tempFilePath = path.join(__dirname, 'cg_block.py');
    fs.writeFileSync(tempFilePath, selectedText);

    const pythonPath =
        vscode.workspace.getConfiguration('pythonLiveExecution').get<string>('pythonPath') || defaultConfig.pythonPath;

    exec(`${pythonPath} "${tempFilePath}"`, (error, stdout, stderr) => {
        if (error || stderr) {

			// Clear any existing decorations before applying new ones
			clearOutput(editor);
			vscode.window.showErrorMessage(stderr.trim() || (error ? error.message : 'Unknown error'));
        } else {
            vscode.window.showInformationMessage(stdout.trim());
        }

        fs.unlinkSync(tempFilePath);
    });
}


function displayInlineOutput(
    output: string,
    editor: vscode.TextEditor,
    currentLine: number,
    executionTime: string,
    isError = false
) {
    if (!output.trim()) {
        return;
    }

    // Clear any existing decorations before applying new ones
    clearOutput(editor);

    const currentLineText = editor.document.lineAt(currentLine).text;
    const currentFilePath = editor.document.fileName; // Get the current file path
    const color = isError
        ? 'red'
        : vscode.workspace.getConfiguration('pythonLiveExecution').get<string>('inlineColor') || defaultConfig.inlineColor;

    // Parse error details if it's an error
    let formattedOutput = output.trim();
    let errorLine = currentLine + 1; // Default to the current line
    let caretPosition = -1; // Default to no caret position

    if (isError) {
        // Check for common error patterns
        const errorMatch = output.match(/File ".*?", line (\d+)/);
        if (errorMatch && errorMatch[1]) {
            errorLine = parseInt(errorMatch[1], 10);
        }

        const caretMatch = output.match(/\n( *\^)/); // Find the caret position
        if (caretMatch && caretMatch[1]) {
            caretPosition = caretMatch[1].length - 1; // Calculate caret offset
        }

        // Format the output with file path, line number, and caret
        formattedOutput = `Error in file: ${currentFilePath} at line ${errorLine}\n${output.trim()}`;
        if (caretPosition >= 0) {
            formattedOutput += `\n${' '.repeat(caretPosition)}^ (Execution Time: ${executionTime}s)`;
        }
    } else {
        // For non-error outputs
        formattedOutput = `${output.trim()} (Execution Time: ${executionTime}s)`;
    }

    // Highlight the appropriate line and append inline content
    const targetLine = Math.min(errorLine - 1, editor.document.lineCount - 1); // Ensure within range
    const targetLineText = editor.document.lineAt(targetLine).text;
    const decorations: vscode.DecorationOptions[] = [
        {
            range: new vscode.Range(targetLine, targetLineText.length, targetLine, targetLineText.length),
            renderOptions: {
                after: {
                    contentText: ` # ${formattedOutput}`,
                    color,
                },
            },
        },
    ];

    if (currentDecorationType) {
        editor.setDecorations(currentDecorationType, []);
        currentDecorationType.dispose();
    }

    currentDecorationType = vscode.window.createTextEditorDecorationType({});
    editor.setDecorations(currentDecorationType, decorations);
}


function deactivate() {
    if (currentDecorationType) {
        currentDecorationType.dispose();
    }
    if (errorDecorationType) {
        errorDecorationType.dispose();
    }
}

module.exports = {
    activate,
    deactivate,
};