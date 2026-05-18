export function inferViewerOrigin(server: string): string {
  if (server.includes('local') || server === 'localhost' || server === '127.0.0.1') {
    return 'http://localhost:3000'
  }
  return `http://${server}:3000`
}
