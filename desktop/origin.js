// Which pages and links the shell trusts. Origins are compared, never URLs, so every path on the
// service stays reachable and another host name for the same service does not.
export function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** The URL when the OS browser may open it, else null. */
export function externalUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Whether an IPC message came from the top frame of `webContents` while it shows the service. */
export function senderTrusted(event, webContents, origin) {
  const frame = event.senderFrame;
  return Boolean(webContents) && event.sender === webContents
    && frame === webContents.mainFrame && sameOrigin(frame.url, origin);
}
