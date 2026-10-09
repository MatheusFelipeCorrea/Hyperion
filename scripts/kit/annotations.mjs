/**
 * GitHub workflow-command escaping for the kit's own scripts
 * (https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts).
 * Properties such as `title=` also need `:` and `,` escaped; the message only `%`, CR, LF.
 */

export function escapeData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function errorAnnotation(title, message) {
  return `::error title=${escapeProperty(title)}::${escapeData(message)}`;
}
