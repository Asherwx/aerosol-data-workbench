import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import './app/app.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('无法启动大气气溶胶数据工作台：页面中缺少 #root 元素。')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
