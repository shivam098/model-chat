export type Theme = "dark" | "light";
/** Per-browser choice; dark is the default when nothing is stored. Not an account setting and never sent to the server. */
export const THEME_STORAGE_KEY = "model-chat-theme";
/** Runs in <head> before the first paint, so a browser that chose light never flashes the dark default. */
export const THEME_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="light")document.documentElement.dataset.theme="light"}catch(e){}`;
