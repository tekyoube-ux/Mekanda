import React from 'react';
import { X, Minus, Square, Folder, HelpCircle } from 'lucide-react';

export default function TitleBar() {
  const handleMinimize = () => {
    window.electronAPI?.windowControl?.minimize();
  };

  const handleMaximize = () => {
    window.electronAPI?.windowControl?.maximize();
  };

  const handleClose = () => {
    window.electronAPI?.windowControl?.close();
  };

  return (
    <div className="h-10 bg-[#0f1115] flex items-center justify-between select-none border-b border-white/[0.03] relative z-[9999]" style={{ WebkitAppRegion: 'drag' }}>
      {/* Sol Kısım: Logo ve İsim */}
      <div className="flex items-center px-4 gap-2.5">
        <div className="w-5 h-5 flex items-center justify-center">
            <img src="./logo.png" alt="Mekanda" className="w-4 h-4 object-contain opacity-90 shadow-[0_0_10px_rgba(255,255,255,0.2)]" />
        </div>
        <span className="text-[13px] font-bold text-gray-200 tracking-tight">Mekanda</span>
      </div>

      {/* Sağ Kısım: Kontrol Butonları ve Ek İkonlar */}
      <div className="flex items-center h-full no-drag" style={{ WebkitAppRegion: 'no-drag' }}>
        <div className="flex items-center px-2 space-x-1">
            <button className="p-2 text-gray-500 hover:text-gray-200 hover:bg-white/5 rounded-lg transition-all">
                <Folder size={16} />
            </button>
            <button className="p-2 text-gray-500 hover:text-gray-200 hover:bg-white/5 rounded-lg transition-all">
                <HelpCircle size={16} />
            </button>
        </div>
        
        <div className="w-[1px] h-4 bg-white/10 mx-2"></div>

        <div className="flex items-center h-full">
            <button 
            onClick={handleMinimize} 
            className="h-full px-4 hover:bg-white/10 text-gray-400 hover:text-white transition-colors flex items-center justify-center outline-none"
            >
            <Minus size={16} />
            </button>
            <button 
            onClick={handleMaximize} 
            className="h-full px-4 hover:bg-white/10 text-gray-400 hover:text-white transition-colors flex items-center justify-center outline-none"
            >
            <Square size={12} />
            </button>
            <button 
            onClick={handleClose} 
            className="h-full px-4 hover:bg-[#e81123] text-gray-400 hover:text-white transition-colors flex items-center justify-center outline-none"
            >
            <X size={16} />
            </button>
        </div>
      </div>
    </div>
  );
}
