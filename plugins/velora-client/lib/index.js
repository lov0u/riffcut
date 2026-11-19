/**
 * host 侧空壳。DSH 加载这个包、读到 package.json 里的 dsh.client 声明，
 * 就会把 ./client（浏览器那半截）一起装进前端 —— 这里不需要任何逻辑。
 */
export const name = 'velora-client'
export function apply() {}
