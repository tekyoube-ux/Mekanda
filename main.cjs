const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const isDev = !app.isPackaged;

// Configure AutoUpdater
autoUpdater.autoDownload = true; // Arka planda otomatik indir
autoUpdater.logger = console;

let audioProcess = null;

// Singleton server instance
let staticServer = null;
let mainWindow;
let tray;

function startStaticServer() {
  const serverPort = 3000;
  const webRoot = path.join(__dirname, 'dist');
  
  if (!fs.existsSync(webRoot)) return null;

  staticServer = http.createServer((req, res) => {
    let filePath = path.join(webRoot, req.url === '/' ? 'index.html' : req.url);
    if (!fs.existsSync(filePath)) {
        filePath = path.join(webRoot, 'index.html'); // SPA desteği için
    }
    
    const extname = path.extname(filePath);
    const contentTypeMap = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.woff': 'application/font-woff',
      '.ttf': 'application/font-ttf',
      '.eot': 'application/vnd.ms-fontobject',
      '.otf': 'application/font-otf',
      '.wasm': 'application/wasm'
    };
    const contentType = contentTypeMap[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
      if (error) {
        res.writeHead(500);
        res.end('Error loading file');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  });

  staticServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('Address in use, closing existing server or skipping...');
      // If we can't listen, it usually means another instance is running 
      // or the port hasn't been released yet.
    }
  });

  try {
    staticServer.listen(serverPort);
  } catch (e) {
    console.error("Failed to start static server:", e);
    return null;
  }
  
  return `http://localhost:${serverPort}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 940,
    minHeight: 600,
    title: "Mekanda",
    icon: path.join(__dirname, isDev ? 'public/logo.png' : 'dist/logo.png'),
    frame: false, // Çerçevesiz pencere
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
    backgroundColor: '#0a0a0c',
    show: false, // Yüklenene kadar gizle
  });

  mainWindow.maximize(); // Tam ekran başlat


  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const url = startStaticServer();
    if (url) {
        mainWindow.loadURL(url);
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
    }
    // mainWindow.webContents.openDevTools(); // debug için gerekirse açılır
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Harici linkleri tarayıcıda aç, Firebase Auth popup'larını Electron'da tut
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Firebase Auth veya Google Login URL'si ise yeni pencerede açılmasına izin ver
    if (url.includes('google.com') || url.includes('firebase') || url.includes('auth')) {
      return { 
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          icon: path.join(__dirname, isDev ? 'public/logo.png' : 'dist/logo.png')
        }
      };
    }
    // Diğer tüm linkleri (örn. yardım sayfaları) harici tarayıcıda aç
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify();
  }
}

function createTray() {
  // Paket yapısına göre logo.png'yi bul (hem dev hem build modu için)
  const iconPath = isDev 
    ? path.join(__dirname, 'public/logo.png') 
    : path.join(process.resourcesPath, 'app/dist/logo.png');

  let icon;
  try {
    if (fs.existsSync(iconPath)) {
        icon = nativeImage.createFromPath(iconPath);
    } else {
        // Alternatif yol denemesi
        const altPath = path.join(__dirname, 'dist/logo.png');
        icon = nativeImage.createFromPath(altPath);
    }
  } catch (e) {
    console.error("Tray icon loading failed:", e);
  }
  
  if (icon && !icon.isEmpty()) {
    tray = new Tray(icon.resize({ width: 24, height: 24 }));
  } else {
    // Fallback: Boş bir ikon oluştur (hata vermemesi için)
    tray = new Tray(nativeImage.createEmpty());
  }
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mekanda\'yı Aç', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Çıkış', click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Mekanda');
  tray.setContextMenu(contextMenu);
  
  tray.on('double-click', () => {
    mainWindow.show();
  });
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Windows'ta tray'de kalması için quit yapmıyoruz
  }
});

// Bildirimler ve diğer IPC işlemleri
ipcMain.handle('get-app-version', () => app.getVersion());

// Pencere Kontrolleri
ipcMain.on('window-minimize', () => {
    mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('window-close', () => {
    app.isQuitting = true;
    app.quit();
});

// --- Native Core Audio Sidecar ---
function startAudioEngine(host, port) {
    if (audioProcess) stopAudioEngine();

    // Determine the path to the audio engine executable
    let enginePath;
    if (isDev) {
        // In dev, try the compiled exe first, then the script
        const devExe = path.join(__dirname, 'bin', 'audio_engine.exe');
        if (fs.existsSync(devExe)) {
            enginePath = devExe;
        } else {
            enginePath = 'python'; // Fallback to script
        }
    } else {
        // In production, use the unpacked exe
        enginePath = path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'audio_engine.exe');
    }

    console.log('Starting Audio Engine from:', enginePath);

    if (enginePath === 'python') {
        const scriptPath = path.join(__dirname, 'audio_engine.py');
        audioProcess = spawn('python', [scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
    } else {
        audioProcess = spawn(enginePath, [], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
    }

    audioProcess.stdout.on('data', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (mainWindow) mainWindow.webContents.send('audio-engine-log', msg);
        } catch (e) {
            console.log('Audio Engine Raw:', data.toString());
        }
    });

    audioProcess.stderr.on('data', (data) => {
        console.error('Audio Engine Error:', data.toString());
    });

    sendAudioCommand({ action: "start", host, port });
}

function stopAudioEngine() {
    if (audioProcess) {
        sendAudioCommand({ action: "exit" });
        audioProcess.kill();
        audioProcess = null;
    }
}

function sendAudioCommand(cmd) {
    if (audioProcess && audioProcess.stdin.writable) {
        audioProcess.stdin.write(JSON.stringify(cmd) + '\n');
    }
}

ipcMain.on('audio-start', (event, { host, port }) => {
    startAudioEngine(host, port);
});

ipcMain.on('audio-stop', () => {
    stopAudioEngine();
});

ipcMain.on('audio-mute', (event, value) => {
    sendAudioCommand({ action: "mute", value });
});

app.on('will-quit', () => {
    stopAudioEngine();
});

// --- AutoUpdater Events ---
autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-available', info);
});

autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow) mainWindow.webContents.send('update-download-progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
});

autoUpdater.on('error', (err) => {
    console.error('AutoUpdater Error:', err);
});

ipcMain.on('start-download-update', () => {
    autoUpdater.downloadUpdate();
});

ipcMain.on('restart-app-for-update', () => {
    autoUpdater.quitAndInstall();
});
