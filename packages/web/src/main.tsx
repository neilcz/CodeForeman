import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 8 },
        components: {
          // 顶部导航与页面同为中性深灰，不要 antd 默认的深蓝
          Layout: { headerBg: '#1f1f1f', headerPadding: '0 16px' },
          Menu: { darkItemBg: 'transparent', horizontalItemSelectedBg: 'rgba(22, 119, 255, 0.15)' },
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
