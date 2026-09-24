/** P14 库外需求兜底：只暴露结构化候选与查询守卫。 */
export { createWebSearch, type SearchCandidate, type WebSearch } from './search.js';
export { buildSearchQuery, UnsafeQueryError } from './query.js';
export { extractContacts, looksLikeListicle, nameFromTitle } from './extract.js';
