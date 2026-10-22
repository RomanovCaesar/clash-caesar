// Vite 的 ?raw 导入：文件内容作为字符串
declare module '*?raw' {
  const content: string
  export default content
}
