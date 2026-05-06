/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/webview/**/*.{tsx,ts,jsx,js}'],
  theme: {
    extend: {
      colors: {
        'vscode-bg': 'var(--vscode-sideBar-background)',
        'vscode-fg': 'var(--vscode-sideBar-foreground)',
        'vscode-input-bg': 'var(--vscode-input-background)',
        'vscode-input-fg': 'var(--vscode-input-foreground)',
        'vscode-input-border': 'var(--vscode-input-border)',
        'vscode-button': 'var(--vscode-button-background)',
        'vscode-button-fg': 'var(--vscode-button-foreground)',
        'vscode-button-hover': 'var(--vscode-button-hoverBackground)',
        'vscode-badge': 'var(--vscode-badge-background)',
        'vscode-badge-fg': 'var(--vscode-badge-foreground)',
        'vscode-error': 'var(--vscode-errorForeground)',
        'vscode-warning': 'var(--vscode-editorWarning-foreground)',
        'vscode-success': '#4ade80',
        'vscode-border': 'var(--vscode-panel-border)',
      },
      fontFamily: {
        vscode: 'var(--vscode-font-family)',
      },
      fontSize: {
        'vscode-sm': 'var(--vscode-font-size)',
      },
    },
  },
  plugins: [],
};
