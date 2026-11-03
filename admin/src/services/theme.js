// Tema do painel. Sem escolha gravada, segue o sistema operacional
// (prefers-color-scheme); o botao da barra superior grava "light" ou "dark".
// localStorage pode falhar (aba anonima, armazenamento bloqueado): o painel
// continua funcionando, so nao lembra a escolha.

const THEME_KEY = "mcall_admin_theme";

export function getStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "";
  } catch (_error) {
    return "";
  }
}

export function getEffectiveTheme() {
  const stored = getStoredTheme();
  if (stored) return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_error) {
    // Sem armazenamento: vale so para esta aba.
  }
  applyTheme(theme);
}
