// Only OS/keychain, certificate and proxy settings reach the runtime, never ambient agent or token variables.
export function runtimeEnvironment() {
  const allowed = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined));
}
