export function render(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in vars)) return '';
    return vars[key];
  });
}
