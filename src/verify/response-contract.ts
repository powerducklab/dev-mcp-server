import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import type { TestResult } from '@powerduck/openapi-cli';

/** Per-suite validator: no type coercion and no remote schema fetching. */
export function responseContractChecker(document: Record<string, any>) {
  const options = { strict: false, allErrors: false, validateFormats: false, coerceTypes: false };
  const validator = /^3\.0\./.test(document.openapi ?? '') ? new Ajv(options) : new Ajv2020(options);
  return (result: TestResult) => {
    if (!result.response?.status || result.status === 'error' || result.status === 'skipped') return;
    const operation = document.paths?.[result.path]?.[result.method.toLowerCase()];
    const responses = operation?.responses;
    if (!responses) return;
    const status = String(result.response.status);
    const contract = responses[status] ?? responses[status[0] + 'XX'] ?? responses.default;
    let error: string | undefined;
    if (!contract) error = `Response status ${status} is not declared in the contract.`;
    else {
      const media = (result.response.contentType ?? '').split(';')[0]!.trim().toLowerCase();
      const content = contract.content;
      const definition = content?.[media] ?? content?.[media.split('/')[0] + '/*'] ?? content?.['*/*'];
      if (content && Object.keys(content).length && !definition) error = `Response media type ${media || '(missing)'} is not declared in the contract.`;
      else if (definition?.schema !== undefined && result.method.toUpperCase() !== "HEAD" && ![204, 304].includes(result.response.status)) {
        if (media === 'application/json' || media.endsWith('+json')) {
          try {
            const body = typeof result.response.text === 'string' ? JSON.parse(result.response.text) : result.response.body;
            const validate = validator.compile(definition.schema);
            if (!validate(body)) error = validate.errors?.map(item => `${item.instancePath || '/'} ${item.message}`).join('; ') ?? 'Response schema mismatch.';
          } catch {
            error = 'Response JSON or schema could not be validated; check the response and contract.';
          }
        } else {
          error = 'Schema validation for this response media type is not supported; verify it manually.';
        }
      }
    }
    (result.assertions ??= []).push({ name: 'Response conforms to OpenAPI contract', passed: !error, ...(error ? { error } : {}) });
    if (error) result.status = 'failed';
  };
}
