/** Never resolve references outside the supplied document or execute embedded
 * scripts through verification's more narrowly scoped network policy. */
export function assertDocumentSafety(document: unknown, verification = false): void {
  const seen = new WeakSet<object>();
  const queue: unknown[] = [document];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if ((key === '$ref' || key === '$dynamicRef') && typeof item === 'string' && !item.startsWith('#')) {
        throw new Error('External OpenAPI references are disabled. Bundle referenced schemas into this document first.');
      }
      if (verification && key === 'x-postman-scripts' && item && typeof item === 'object' && Object.keys(item).length) {
        throw new Error('MCP verification cannot execute embedded Postman scripts because their network requests cannot be restricted. Use declarative assertions or the Debug workspace.');
      }
      if (item && typeof item === 'object') queue.push(item);
    }
  }
}
