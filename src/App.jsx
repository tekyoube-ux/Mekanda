import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Hash, Send, Users, Menu, X, MessageSquare, Settings, Volume2, PhoneOff, Image as ImageIcon, Maximize2, LogOut, Mic, MicOff, Camera, Edit3, VolumeX, UserMinus, Plus, Trash, Sliders, MoreHorizontal, Check, UserPlus, UserCheck, Bell, Copy, ImagePlus, Upload, Pencil } from 'lucide-react';
import Peer from 'peerjs';
import { Rnnoise } from '@shiguredo/rnnoise-wasm';

import { onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, onSnapshot, addDoc, doc, setDoc, deleteDoc, query, orderBy, where, getDoc, getDocs, increment, getCountFromServer } from 'firebase/firestore';

import { auth, db, storage, APP_ID } from './firebase';
import { ref, uploadBytes, getDownloadURL, uploadString } from 'firebase/storage';
import Auth from './Auth';
import TitleBar from './components/TitleBar';

const AVAILABLE_GAMES = [
    { id: 'csgo', name: 'CS:GO', color: 'text-orange-400', bg: 'bg-orange-500/20', iconUrl: 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/730/69f7ebe2735c366c65c0b33dae00e12dc40edbe4.jpg' },
    { id: 'valorant', name: 'Valorant', color: 'text-red-500', bg: 'bg-red-500/20', iconUrl: 'https://cdn.simpleicons.org/valorant/ef4444' },
    { id: 'ko', name: 'Knight Online', color: 'text-yellow-500', bg: 'bg-yellow-500/20', iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/382260/library_600x900.jpg' },
    { id: 'gtav', name: 'GTA V', color: 'text-green-500', bg: 'bg-green-500/20', iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/271590/library_600x900.jpg' },
    { id: 'lol', name: 'League of Legends', color: 'text-blue-400', bg: 'bg-blue-500/20', iconUrl: 'https://cdn.simpleicons.org/leagueoflegends/3b82f6' },
    { id: 'minecraft', name: 'Minecraft', color: 'text-emerald-500', bg: 'bg-emerald-500/20', iconUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/minecraft.png' },
    { id: 'rust', name: 'Rust', color: 'text-amber-600', bg: 'bg-amber-600/20', iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/252490/library_600x900.jpg' },
    { id: 'apex', name: 'Apex Legends', color: 'text-rose-600', bg: 'bg-rose-600/20', iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1172470/library_600x900.jpg' },
    { id: 'deltaforce', name: 'Delta Force', color: 'text-purple-500', bg: 'bg-purple-500/20', iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2507950/library_600x900.jpg' },
];

// Singleton AudioContext to prevent overloading the browser and causing stuttering
let globalAudioContext = null;
const getAudioContext = () => {
    if (!globalAudioContext) {
        // FORCE 48000Hz for RNNoise compatibility and stability
        globalAudioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 48000,
            latencyHint: 'interactive'
        });
        console.log("AudioContext Created! Sample Rate:", globalAudioContext.sampleRate);
    }
    if (globalAudioContext.state === 'suspended') {
        globalAudioContext.resume();
    }
    return globalAudioContext;
};

const ParticipantAudio = ({ stream, onSpeakingChange, muted = false, userId = null, isDeafened = false, suppressOutput = false }) => {
    const audioRef = useRef(null);
    const nodesRef = useRef(null); // { source, analyser, outputGain }
    const speakingRef = useRef(false);
    const timeoutRef = useRef(null);

    // 1. Setup Audio Graph (Only when stream changes)
    useEffect(() => {
        if (!stream) return;

        const audioContext = getAudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        const outputGain = audioContext.createGain();

        // Route: Source -> Analyser -> OutputGain
        source.connect(analyser);
        analyser.connect(outputGain);

        // Only connect to destination if NOT suppressed (Local user fix)
        if (!suppressOutput) {
            outputGain.connect(audioContext.destination);
        }

        nodesRef.current = { source, analyser, outputGain };

        // Keep <audio> element for metadata/keep-alive but muted
        if (audioRef.current) {
            audioRef.current.srcObject = stream;
            audioRef.current.muted = true;
            audioRef.current.play().catch(e => console.warn("Audio tag sync error:", e));
        }

        return () => {
            if (nodesRef.current) {
                nodesRef.current.source.disconnect();
                nodesRef.current.analyser.disconnect();
                nodesRef.current.outputGain.disconnect();
                nodesRef.current = null;
            }
        };
    }, [stream]);

    // 2. Sync Gain (Mute/Deafen)
    useEffect(() => {
        if (nodesRef.current?.outputGain) {
            const audioContext = getAudioContext();
            const targetGain = (muted || isDeafened) ? 0 : 1;
            nodesRef.current.outputGain.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.05);
        }
    }, [muted, isDeafened]);

    // 3. Speaking Indicator Logic
    useEffect(() => {
        if (!nodesRef.current?.analyser) return;

        const analyser = nodesRef.current.analyser;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const intervalId = setInterval(() => {
            analyser.getByteTimeDomainData(dataArray);

            let maxVal = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const val = Math.abs(dataArray[i] - 128);
                if (val > maxVal) maxVal = val;
            }

            const isCurrentlySpeaking = maxVal > 10;

            if (isCurrentlySpeaking) {
                if (timeoutRef.current) {
                    clearTimeout(timeoutRef.current);
                    timeoutRef.current = null;
                }
                if (!speakingRef.current) {
                    speakingRef.current = true;
                    onSpeakingChange(true);
                }
            } else if (speakingRef.current && !timeoutRef.current) {
                timeoutRef.current = setTimeout(() => {
                    speakingRef.current = false;
                    onSpeakingChange(false);
                    timeoutRef.current = null;
                }, 250);
            }
        }, 100);

        return () => {
            clearInterval(intervalId);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, [stream, onSpeakingChange]);

    return (
        <audio
            ref={audioRef}
            id={userId ? `audio-${userId}` : undefined}
            autoPlay
            muted={true}
            style={{ position: 'fixed', top: 0, left: 0, width: 1, height: 1, opacity: 0.01, pointerEvents: 'none' }}
        />
    );
};

// Kanallar artık Firestore'dan dinamik olarak gelecek.

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        this.setState({ errorInfo });
    }
    render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: 20, color: 'red', background: '#111', height: '100vh', width: '100vw', overflow: 'auto', zIndex: 9999, position: 'fixed', top: 0, left: 0 }}>
                    <h2 style={{ fontSize: '24px', fontWeight: 'bold' }}>React Crash Boundary Caught An Error!</h2>
                    <pre style={{ marginTop: 20 }}>{this.state.error && this.state.error.toString()}</pre>
                    <pre style={{ marginTop: 10, color: '#ffaaaa' }}>{this.state.errorInfo && this.state.errorInfo.componentStack}</pre>
                </div>
            );
        }
        return this.props.children;
    }
}

const UpdateNotification = () => {
    const [updateInfo, setUpdateInfo] = useState(null);
    const [progress, setProgress] = useState(null);
    const [status, setStatus] = useState('idle'); // 'idle', 'available', 'downloading', 'ready'

    useEffect(() => {
        if (!window.electronAPI?.updateControl) return;

        window.electronAPI.updateControl.onAvailable((info) => {
            setUpdateInfo(info);
            setStatus('available');
        });

        window.electronAPI.updateControl.onProgress((p) => {
            setProgress(p);
            setStatus('downloading');
        });

        window.electronAPI.updateControl.onDownloaded(() => {
            setStatus('ready');
        });
    }, []);

    if (status === 'idle') return null;

    return (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[99999] w-[90%] max-w-md">
            <div className="bg-indigo-600/95 backdrop-blur-md border border-indigo-400/50 shadow-2xl rounded-xl p-4 text-white flex flex-col gap-3 animate-in fade-in slide-in-from-top-4 duration-500">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-white/10 rounded-lg">
                        <Bell className="w-5 h-5 text-indigo-100" />
                    </div>
                    <div className="flex-1">
                        <h3 className="font-bold text-sm">Güncelleme Mevcut!</h3>
                        <p className="text-xs text-indigo-100 opacity-90">v{updateInfo?.version} sürümü hazır.</p>
                    </div>
                    {status === 'available' && (
                        <div className="bg-white/10 px-3 py-1 rounded-lg text-[10px] font-bold text-indigo-100 flex items-center animate-pulse">
                            İndirme Başlıyor...
                        </div>
                    )}
                    {status === 'ready' && (
                        <button 
                            onClick={() => window.electronAPI.updateControl.install()}
                            className="bg-green-500 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-green-400 transition-colors shadow-sm"
                        >
                            Şimdi Kur
                        </button>
                    )}
                </div>
                
                {status === 'downloading' && (
                    <div className="space-y-1.5">
                        <div className="flex justify-between text-[10px] font-medium text-indigo-100 italic">
                            <span>İndiriliyor...</span>
                            <span>%{Math.round(progress?.percent || 0)}</span>
                        </div>
                        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <div 
                                className="h-full bg-white transition-all duration-300 ease-out"
                                style={{ width: `${progress?.percent || 0}%` }}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

function MainApp() {
    const { serverId, channelId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();

    const [user, setUser] = useState(null);
    const [userName, setUserName] = useState('');
    const [userProfilePic, setUserProfilePic] = useState('');
    const [appVersion, setAppVersion] = useState('...');

    useEffect(() => {
        if (window.electronAPI?.getAppVersion) {
            window.electronAPI.getAppVersion().then(v => setAppVersion(v));
        }
    }, []);

    const isCeo = user && (user.email === 'merttekinler07@gmail.com');
    const [messages, setMessages] = useState([]);
    const [channels, setChannels] = useState([]);
    const [voiceChannels, setVoiceChannels] = useState([]);
    const [servers, setServers] = useState([]);
    const [allServers, setAllServers] = useState([]);
    const [isServersLoaded, setIsServersLoaded] = useState(false);
    const [forceLoad, setForceLoad] = useState(false);
    const activeServerId = serverId || (location.pathname === '/' || location.pathname === '/home' ? 'home' : (servers[0]?.id || 'home'));
    const activeChannel = channelId || null;
    const activeServer = Array.isArray(servers) ? (servers.find(s => s.id === activeServerId) || (isCeo ? allServers.find(s => s.id === activeServerId) : null)) : null;
    const [newMessage, setNewMessage] = useState('');
    const [showDiscovery, setShowDiscovery] = useState(location.pathname === '/' || location.pathname === '/home');
    const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth < 768);
    const [loading, setLoading] = useState(true);
    const [minLoading, setMinLoading] = useState(true);
    const [userRole, setUserRole] = useState('user'); // Admin, Moderator, User
    const presenceIntervalRef = useRef(null);
    const [isMembersListOpen, setIsMembersListOpen] = useState(window.innerWidth >= 768);
    const [allUsers, setAllUsers] = useState([]);
    const [ping, setPing] = useState(0);

    // Latency (Ping) Measurement Logic
    useEffect(() => {
        const measurePing = async () => {
            const start = Date.now();
            try {
                // Fetching a small resource to measure latency
                await fetch('./logo.png', { method: 'HEAD', cache: 'no-store' });
                const end = Date.now();
                setPing(end - start);
            } catch (err) {
                console.warn("Ping measurement failed", err);
            }
        };

        measurePing();
        const interval = setInterval(measurePing, 10000);
        return () => clearInterval(interval);
    }, []);

    // Status Edit Modal States
    const [editingStatus, setEditingStatus] = useState(false);
    const [tempStatus, setTempStatus] = useState("");

    // Favori Oyunlar Yöneticisi
    const [isEditingGames, setIsEditingGames] = useState(false);
    const [tempGames, setTempGames] = useState([]);

    // Arkadaş Sistemi
    const [showFriends, setShowFriends] = useState(false);
    const [myFriends, setMyFriends] = useState([]);
    const [incomingRequests, setIncomingRequests] = useState([]);
    const [outgoingRequests, setOutgoingRequests] = useState([]);
    const [friendTab, setFriendTab] = useState('all'); // 'all' | 'pending'

    // ÖZel Mesajlaşma (DM) Sistemi
    const [showDMs, setShowDMs] = useState(false);
    const [activeDM, setActiveDM] = useState(null); // { friendId, friendName, friendPhotoURL }
    const [dmMessages, setDmMessages] = useState([]);
    const [dmInput, setDmInput] = useState('');
    const [dmUnreadCounts, setDmUnreadCounts] = useState({}); // { [convId]: number }
    const [userReadStates, setUserReadStates] = useState({}); // { [channelId]: number }
    const dmMessagesEndRef = useRef(null);

    // Rol Yönetimi Modalı States
    const [selectedUserForRole, setSelectedUserForRole] = useState(null); // { id, name, currentRole, customRoles }
    const [profileUserModal, setProfileUserModal] = useState(null); // { id, name, photoURL, role, customRoles }
    const [serverRoles, setServerRoles] = useState([]);
    const [newRoleName, setNewRoleName] = useState('');
    const [newRoleColor, setNewRoleColor] = useState('indigo'); // Tailwind color name

    // Upload State
    const [uploadLoading, setUploadLoading] = useState(false);
    const [uploadToast, setUploadToast] = useState(null); // { type, message }

    const showToast = (type, message) => {
        setUploadToast({ type, message });
        setTimeout(() => setUploadToast(null), 3500);
    };

    // Refs for File Uploads
    const pfpInputRef = useRef(null);
    const bannerInputRef = useRef(null);
    const chatImageInputRef = useRef(null);
    const dmImageInputRef = useRef(null);

    const [lightboxImage, setLightboxImage] = useState(null);

    // Sunucu Oluşturma Modalı
    const [isCreateServerModalOpen, setIsCreateServerModalOpen] = useState(false);
    const [isServerSettingsModalOpen, setIsServerSettingsModalOpen] = useState(false);
    const [serverSettingsName, setServerSettingsName] = useState('');
    const [serverSettingsLogo, setServerSettingsLogo] = useState('');
    const [serverSettingsLogoFile, setServerSettingsLogoFile] = useState(null);
    const [serverSettingsBanner, setServerSettingsBanner] = useState('');
    const [serverSettingsBannerFile, setServerSettingsBannerFile] = useState(null);
    const [editingChannelId, setEditingChannelId] = useState(null);
    const [editingChannelName, setEditingChannelName] = useState('');
    const serverSettingsLogoInputRef = useRef(null);
    const serverSettingsBannerInputRef = useRef(null);
    const serverLogoInputRef = useRef(null);
    const [newServerName, setNewServerName] = useState('');
    const [newServerLogo, setNewServerLogo] = useState('');
    const audioProcessorRef = useRef(null);
    const audioIntervalRef = useRef(null);
    const localStreamRef = useRef(null);
    const rnnoiseModuleRef = useRef(null);
    const noiseSuppressRef = useRef(true);
    const [isJoinRequestsModalOpen, setIsJoinRequestsModalOpen] = useState(false);
    const [joinRequests, setJoinRequests] = useState([]); // Pending requests for the active server
    const [myPendingRequests, setMyPendingRequests] = useState({}); // { [serverId]: boolean }

    // Sunucu Katılma/Oluşturma Akışı
    const [serverModalView, setServerModalView] = useState('selection'); // 'selection' | 'create' | 'join'
    const [inviteInput, setInviteInput] = useState('');
    const [myMemberships, setMyMemberships] = useState([]); // Array of server IDs
    const [activeServerMembers, setActiveServerMembers] = useState([]); // Users in active server


    const [joinedVoiceChannel, setJoinedVoiceChannel] = useState(null);
    const [voiceUsers, setVoiceUsers] = useState([]);

    // Ses Ayarları
    const [isMuted, setIsMuted] = useState(false);
    const [isPTTMode, setIsPTTMode] = useState(false);
    const [isPTTActive, setIsPTTActive] = useState(false); // PTT modda konuşuyor mu
    const [noiseSuppress, setNoiseSuppress] = useState(true);
    const [echoCancellation, setEchoCancellation] = useState(true);
    const [isVoiceSettingsOpen, setIsVoiceSettingsOpen] = useState(false);
    const [isChannelSettingsOpen, setIsChannelSettingsOpen] = useState(false);
    const [channelSettingsType, setChannelSettingsType] = useState('text'); // 'text' or 'voice'

    const [localStream, setLocalStream] = useState(null);
    const [remoteStreams, setRemoteStreams] = useState({});
    const [userVolumes, setUserVolumes] = useState({}); // userId -> volume 0..1
    const [speakingUsers, setSpeakingUsers] = useState(new Set());
    const [isDeafened, setIsDeafened] = useState(false);
    // URL/State senkronizasyonu useEffect'i kaldırıldı (artık doğrudan useParams'tan türüyor)
    const callsRef = useRef({});
    const peerRef = useRef(null);
    const prevVoiceInMyChannelRef = useRef([]);

    // Global AudioContext & RNNoise Pre-load
    useEffect(() => {
        const handleInteraction = () => {
            getAudioContext().resume();
        };
        window.addEventListener('click', handleInteraction);
        window.addEventListener('keydown', handleInteraction);

        // Pre-load RNNoise Module Factory
        Rnnoise.load().then(factory => {
            console.log("RNNoise Factory Loaded");
            rnnoiseModuleRef.current = factory; // Store the factory
        }).catch(err => console.error("RNNoise load error:", err));

        return () => {
            window.removeEventListener('click', handleInteraction);
            window.removeEventListener('keydown', handleInteraction);
        };
    }, []);

    // 4 Saniye Mecburi Yükleme Ekranı
    useEffect(() => {
        const timer = setTimeout(() => {
            setMinLoading(false);
            console.log("Min loading time reached.");
        }, 4000);
        return () => clearTimeout(timer);
    }, []);

    // Real-time Mute/Deafen Sync with Firestore
    useEffect(() => {
        if (!user || !joinedVoiceChannel) return;
        const userVoiceRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence', user.uid);
        setDoc(userVoiceRef, { isMuted, isDeafened, lastActive: Date.now() }, { merge: true });

        // Also apply mute to local track
        if (localStream) {
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !isMuted;
            });
        }

        if (window.electronAPI && window.electronAPI.audioControl) {
            window.electronAPI.audioControl.mute(isMuted);
        }
    }, [isMuted, isDeafened, joinedVoiceChannel, user?.uid]);

    const playNotificationSound = () => {
        try {
            const ctx = getAudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(660, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.05);

            gain.gain.setValueAtTime(0.04, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start();
            osc.stop(ctx.currentTime + 0.15);
        } catch (e) {
            console.warn("Ses efekti çalınamadı:", e);
        }
    };

    const handleSpeakingChange = React.useCallback((uid, isSpeaking) => {
        setSpeakingUsers(prev => {
            if (isSpeaking && prev.has(uid)) return prev;
            if (!isSpeaking && !prev.has(uid)) return prev;

            const next = new Set(prev);
            if (isSpeaking) next.add(uid);
            else next.delete(uid);
            return next;
        });
    }, []);

    const addRemoteStream = (peerId, stream) => {
        setRemoteStreams(prev => ({ ...prev, [peerId]: stream }));
    };

    const removeRemoteStream = (peerId) => {
        setRemoteStreams(prev => {
            const newStreams = { ...prev };
            delete newStreams[peerId];
            return newStreams;
        });
    };

    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, activeChannel]);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            // Safety timeout: Eğer 6 saniye içinde sunucular yüklenmezse zorla yüklemeyi bitir
            const safetyTimeout = setTimeout(() => {
                if (currentUser) {
                    setIsServersLoaded(true);
                    setForceLoad(true);
                }
            }, 6000);

            if (currentUser) {
                setUser(currentUser);

                // Firestore'da kullanıcı dökümanı var mı kontrol et
                const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', currentUser.uid);
                const userSnap = await getDoc(userDocRef);

                let finalName = currentUser.displayName || 'İsimsiz';
                let finalPfp = currentUser.photoURL || '';

                if (!userSnap.exists()) {
                    console.log("Kullanıcı kaydı bulunamadı, oluşturuluyor...");
                    await setDoc(userDocRef, {
                        id: currentUser.uid,
                        name: finalName,
                        photoURL: finalPfp,
                        email: currentUser.email,
                        createdAt: Date.now(),
                        lastLogin: Date.now()
                    }, { merge: true });
                } else {
                    const data = userSnap.data();
                    finalName = data.name || finalName;
                    finalPfp = data.photoURL || finalPfp;
                    await setDoc(userDocRef, { lastLogin: Date.now() }, { merge: true });
                }

                setUserName(finalName);
                setUserProfilePic(finalPfp);
            } else {
                setUser(null);
                setUserRole('user');
                setUserName('İsimsiz');
                setUserProfilePic('');
            }
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    // PTT (Bas-Konuş) Sistemi
    useEffect(() => {
        if (!joinedVoiceChannel || !isPTTMode || !localStream) return;

        // PTT modunda başlangıçta mikrofonu kapat
        localStream.getAudioTracks().forEach(t => { t.enabled = false; });
        setIsMuted(true);

        const handleKeyDown = (e) => {
            if (e.code === 'Space' && !e.repeat) {
                localStream.getAudioTracks().forEach(t => { t.enabled = true; });
                setIsPTTActive(true);
                setIsMuted(false);
            }
        };
        const handleKeyUp = (e) => {
            if (e.code === 'Space') {
                localStream.getAudioTracks().forEach(t => { t.enabled = false; });
                setIsPTTActive(false);
                setIsMuted(true);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [joinedVoiceChannel, isPTTMode, localStream]);

    // Sağırlaştır (Deafen) Kontrolü
    useEffect(() => {
        const rootElement = document.getElementById('root');
        if (rootElement) {
            rootElement.dataset.deafened = isDeafened ? 'true' : 'false';
        }

        // Mevcut tüm ses elemanlarını da anında güncelle
        const audioElements = document.querySelectorAll('audio[id^="audio-"]');
        audioElements.forEach(el => {
            el.muted = isDeafened;
        });

        // Sağırlaştırma açıldığında mikrofonu da zorunlu kapat (kendi sesimiz de gitmesin)
        if (isDeafened && !isMuted) {
            setIsMuted(true);
        }
    }, [isDeafened, isMuted]);

    // Mute state'i değiştiğinde stream track'ini güncelle (PTT modda değil)
    useEffect(() => {
        if (!localStream || isPTTMode) return;
        localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    }, [isMuted, localStream, isPTTMode]);

    // Firestore'da ses/sağırlık durumunu senkronize et
    useEffect(() => {
        if (!user || !joinedVoiceChannel) return;
        const userVoiceRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence', user.uid);
        setDoc(userVoiceRef, {
            isMuted: isMuted,
            isDeafened: isDeafened,
            lastActive: Date.now()
        }, { merge: true }).catch(err => console.error("Ses durumu güncellenemedi:", err));
    }, [isMuted, isDeafened, user, joinedVoiceChannel]);

    // Sunucu Üyeliklerini ve Listesini Dinle
    useEffect(() => {
        if (!user) return;

        // Önce kullanıcının kendi üyeliklerini dinle
        console.log("Sunucu üyelikleri dinleniyor: ", user.uid);
        const membershipsRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'memberships', user.uid, 'servers');

        const unsubMemberships = onSnapshot(membershipsRef, (snapshot) => {
            const mList = snapshot.docs.map(doc => doc.id);
            setMyMemberships(mList);
            console.log("Üyelikler yüklendi:", mList);

            // Üye olduğumuz sunucuları çek
            if (mList.length > 0) {
                const serversRef = query(
                    collection(db, 'artifacts', APP_ID, 'public', 'data', 'servers'),
                    where('__name__', 'in', mList)
                );
                onSnapshot(serversRef, (snap) => {
                    const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    setServers(list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
                    console.log("Sunucu detayları yüklendi:", list.length);
                    setIsServersLoaded(true);
                }, (error) => {
                    console.error("Sunucu detayları çekilirken hata:", error);
                    setIsServersLoaded(true); // Hata olsa bile yüklemeyi bitir (sonsuz ekrana düşmemek için)
                });
            } else {
                setServers([]);
                setIsServersLoaded(true);
                console.log("Hiçbir sunucuya üye değil.");
            }
        }, (error) => {
            console.error("Üyelikler dinlenirken hata:", error);
            setIsServersLoaded(true); // Hata olsa bile yüklemeyi bitir
        });

        return () => unsubMemberships();
    }, [user]);

    // TÜM Sunucuları Çekme (Keşfet Sayfası İçin)
    useEffect(() => {
        if (!user) return;
        const serversRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'servers');
        const unsub = onSnapshot(serversRef, (snap) => {
            const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setAllServers(list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
            console.log("Tüm sunucular (Keşfet) yüklendi:", list.length);

            // Self-Healing Script for broken memberCounts (Running on Background)
            list.forEach(async (srv) => {
                if (srv.id) {
                    try {
                        const smRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', srv.id, 'users');
                        const cSnap = await getCountFromServer(smRef);
                        const trueCount = cSnap.data().count;
                        if (trueCount > 0 && srv.memberCount !== trueCount) {
                            // Patch the database so everyone sees it instantly next time without caching errors
                            const srvDoc = doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', srv.id);
                            await setDoc(srvDoc, { memberCount: trueCount }, { merge: true });
                        }
                    } catch (e) {
                        console.error("Count sync error:", e);
                    }
                }
            });
        });
        return () => unsub();
    }, [user]);

    // Kanal Listesi Dinleyici (Yeni Birleşik Yapı - İndeks Hatasını Önlemek İçin)
    useEffect(() => {
        if (!user || activeServerId === 'home') {
            setChannels([]);
            setVoiceChannels([]);
            return;
        }

        // Tweak: if we are the owner, ensure the member count is synced if missing. Done locally here for quick legacy sync.
        if (activeServer?.ownerId === user.uid && (!activeServer.memberCount || activeServer.memberCount < 2)) {
            const syncMemberCount = async () => {
                try {
                    const smRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', activeServerId, 'users');
                    const smSnap = await getDocs(smRef);
                    if (!smSnap.empty) {
                        const trueCount = smSnap.size;
                        if (activeServer.memberCount !== trueCount) {
                            await setDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', activeServerId), { memberCount: trueCount }, { merge: true });
                            console.log(`Synced legacy member count for ${activeServerId} to ${trueCount}`);
                        }
                    }
                } catch (err) {
                    console.error("Member count sync error:", err);
                }
            };
            syncMemberCount();
        }

        const channelsRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'channels');
        const q = query(channelsRef, where('serverId', '==', activeServerId));
        console.log("Kanal listesi dinleniyor:", activeServerId);

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const allChannelsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            // JS Tarafında Sıralama (Firestore İndeksi Gerektirmez)
            allChannelsList.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

            setChannels(allChannelsList.filter(c => c.type === 'text' || !c.type));
            setVoiceChannels(allChannelsList.filter(c => c.type === 'voice'));
            console.log("Kanallar güncellendi:", allChannelsList.length);
        }, (error) => {
            console.error("Kanal listesi dinlenirken hata:", error);
        });

        return () => unsubscribe();
    }, [user, activeServerId]);

    // Arkadaş Sistemi - Firebase Listeners
    useEffect(() => {
        if (!user) return;

        // Gelen arkadaş isteklerini dinle
        const incomingRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', user.uid, 'incoming');
        const unsubIncoming = onSnapshot(incomingRef, (snap) => {
            setIncomingRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });

        // Gönderilen istekleri dinle
        const outgoingRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', user.uid, 'outgoing');
        const unsubOutgoing = onSnapshot(outgoingRef, (snap) => {
            setOutgoingRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });

        // Kabul edilmiş arkadaşları dinle
        const friendsRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'friends', user.uid, 'list');
        const unsubFriends = onSnapshot(friendsRef, (snap) => {
            setMyFriends(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });

        return () => { unsubIncoming(); unsubOutgoing(); unsubFriends(); };
    }, [user]);

    // DM Okunmamış sayıcı dinleyici
    useEffect(() => {
        if (!user) return;
        const unreadRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'dmUnread', user.uid, 'convs');
        const unsub = onSnapshot(unreadRef, (snap) => {
            const counts = {};
            snap.forEach(d => { counts[d.id] = d.data().count || 0; });
            setDmUnreadCounts(counts);
        });
        return () => unsub();
    }, [user]);

    // Kanal Okunmamış sayaç dinleyici (Geliştirilmiş ve Robust)
    useEffect(() => {
        if (!user) return;
        const unreadRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'user_read_states', user.uid, 'channels');
        const unsub = onSnapshot(unreadRef, (snap) => {
            const states = {};
            snap.forEach(d => { 
                const data = d.data();
                states[d.id] = typeof data.readCount === 'number' ? data.readCount : 0; 
            });
            setUserReadStates(states);
            console.log("[Badge] User read states updated:", Object.keys(states).length);
        });
        return () => unsub();
    }, [user]);

    // Aktif kanalı okundu olarak işaretle (Performans ve Doğrulık Odaklı)
    useEffect(() => {
        if (!user || !activeChannel || !channels.length) return;
        
        const channelData = channels.find(c => c.id === activeChannel);
        if (!channelData) return;

        const currentTotal = Number(channelData.totalMessages || 0);
        const myReadCount = Number(userReadStates[activeChannel] || 0);

        // Eğer yeni mesaj varsa veya hiç okunmamışsa (readCount yoksa) güncelle
        if (currentTotal > myReadCount || !(activeChannel in userReadStates)) {
            console.log(`[Badge] Auto-marking ${activeChannel} as read (Total: ${currentTotal})`);
            const readStateRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'user_read_states', user.uid, 'channels', activeChannel);
            setDoc(readStateRef, { readCount: currentTotal }, { merge: true }).catch(err => console.error("ReadState Error:", err));
        }
    }, [user, activeChannel, channels, userReadStates]);

    // Aktif DM konuşma mesajlarını dinle
    useEffect(() => {
        if (!user || !activeDM) { setDmMessages([]); return; }
        const convId = getDmConvId(user.uid, activeDM.friendId);
        const msgsRef = query(
            collection(db, 'artifacts', APP_ID, 'public', 'data', 'directMessages', convId, 'messages'),
            orderBy('createdAt', 'asc')
        );
        const unsub = onSnapshot(msgsRef, (snap) => {
            setDmMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });
        markDMRead(convId);
        return () => unsub();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, activeDM]);

    // DM mesajları gelince en alta kaydr
    useEffect(() => {
        if (dmMessagesEndRef.current) {
            dmMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [dmMessages]);

    // İlk kanalı otomatik seç (Navigate ile)
    useEffect(() => {
        if (activeServerId !== 'home' && channels.length > 0 && !channelId) {
            navigate(`/${activeServerId}/${channels[0].id}`, { replace: true });
        }
    }, [activeServerId, channels.length, channelId, navigate]);

    // Presence (Heartbeat) Sistemi - Herkesi Kapsar
    useEffect(() => {
        if (!user) return;

        const updatePresence = async () => {
            try {
                // Global Presence
                const presenceRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'presence', user.uid);
                await setDoc(presenceRef, {
                    lastActive: Date.now(),
                    id: user.uid,
                    userName,
                    profilePic: userProfilePic
                }, { merge: true });

                // Voice Presence Heartbeat (Eğer seste ise)
                if (joinedVoiceChannel) {
                    const voicePresenceRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence', user.uid);
                    await setDoc(voicePresenceRef, {
                        lastActive: Date.now()
                    }, { merge: true });
                }
            } catch (err) {
                console.error("Presence update error:", err);
            }
        };

        // Hemen bir sinyal gönder
        updatePresence();

        // Her 2 dakikada bir "ben buradayım" sinyali gönder (Kota tasarrufu için artırıldı)
        presenceIntervalRef.current = setInterval(updatePresence, 120000);

        return () => {
            if (presenceIntervalRef.current) clearInterval(presenceIntervalRef.current);
        };
    }, [user, userName, userProfilePic, joinedVoiceChannel]);

    // Ses Presence ve Global Presence Senkronizasyonu
    const [onlineUsers, setOnlineUsers] = useState([]);
    useEffect(() => {
        if (!user) return;
        const presenceRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'presence');
        const unsubscribe = onSnapshot(presenceRef, (snapshot) => {
            const now = Date.now();
            const active = [];
            snapshot.forEach((doc) => {
                const data = doc.data();
                if (data.lastActive && (now - data.lastActive) < 150000) {
                    active.push(doc.id);
                }
            });
            setOnlineUsers(active);
        });
        return () => unsubscribe();
    }, [user]);

    // Mesajları Çekme (Dizine (index) gerek duymamak için orderBy sorgudan çıkarıldı)
    useEffect(() => {
        if (!user || !activeChannel) {
            setMessages([]);
            return;
        }

        const messagesRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'messages');

        // orderBy çıkarıldı çünkü where ile beraber kullanıldığında kompozit indeks gerektirir.
        const q = query(
            messagesRef,
            where('channelId', '==', activeChannel)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const msgs = [];
            snapshot.forEach((doc) => {
                msgs.push({ id: doc.id, ...doc.data() });
            });
            // JS tarafında sıralama
            msgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            setMessages(msgs);
        }, (error) => {
            console.error("Mesajlar çekilirken hata:", error);
        });

        return () => unsubscribe();
    }, [user, activeChannel]);

    // Aktif sunucudaki Rolümüzü takip et
    useEffect(() => {
        if (!user || activeServerId === 'home') {
            setUserRole('user');
            return;
        }
        const myMember = allUsers.find(u => u.id === user.uid);
        if (myMember && myMember.role) {
            setUserRole(myMember.role);
        } else {
            setUserRole('user');
        }
    }, [allUsers, user, activeServerId]);

    // Kullanıcıları Çekme - Global users koleksiyonundan al, server_members'dan rol bilgisini merge et
    useEffect(() => {
        if (!user) return;

        // Her zaman global users koleksiyonundan çek (favoriteGames, photoURL, bannerURL burada)
        const usersRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'users');

        const unsubUsers = onSnapshot(usersRef, (snapshot) => {
            const globalUsers = {};
            snapshot.forEach((doc) => {
                globalUsers[doc.id] = { id: doc.id, ...doc.data() };
            });

            if (activeServerId === 'home') {
                // Home modunda: tüm global kullanıcılar (rol yok)
                setAllUsers(Object.values(globalUsers));
            } else {
                // Sunucu modunda: server_members'dan rol bilgisini çek ve merge et
                const membersRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', activeServerId, 'users');
                onSnapshot(membersRef, (memberSnap) => {
                    const merged = [];
                    memberSnap.forEach((doc) => {
                        const globalData = globalUsers[doc.id];
                        // Sadece global users koleksiyonunda var olan kullanıcıları göster (Hayalet kullanıcıları filtrele)
                        if (globalData) {
                            const memberData = doc.data();
                            merged.push({
                                id: doc.id,
                                ...globalData,
                                role: memberData.role || globalData.role || 'user',
                                customRoles: memberData.customRoles || globalData.customRoles || [],
                            });
                        }
                    });
                    setAllUsers(merged);
                });
            }
        });

        return () => unsubUsers();
    }, [user, activeServerId]);

    // Mevcut kullanıcının profil bilgilerini reaktif olarak Firestore'dan güncelle
    useEffect(() => {
        if (!user) return;
        const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
        const unsub = onSnapshot(userDocRef, (snap) => {
            if (!snap.exists()) return;
            const data = snap.data();
            if (data.photoURL !== undefined) {
                setUserProfilePic(data.photoURL || '');
                if (data.photoURL) localStorage.setItem('miniDiscordPfp', data.photoURL);
            }
            if (data.name) {
                setUserName(data.name);
                localStorage.setItem('miniDiscordName', data.name);
            }
        });
        return () => unsub();
    }, [user]);

    // Tüm Rolleri Çekme
    useEffect(() => {
        if (!user) return;
        const rolesRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'roles');
        const unsubscribe = onSnapshot(rolesRef, (snapshot) => {
            const rList = [];
            snapshot.forEach((doc) => {
                rList.push({ id: doc.id, ...doc.data() });
            });
            setServerRoles(rList);
        });
        return () => unsubscribe();
    }, [user]);

    // Katılım İsteklerini Dinle (Admin için aktif sunucudakileri, User için kendi isteklerini)
    useEffect(() => {
        if (!user) {
            setJoinRequests([]);
            setMyPendingRequests({});
            return;
        }

        // 1. Admin ise aktif sunucudaki istekleri dinle
        let unsubAdmin = () => {};
        if (activeServerId !== 'home' && userRole === 'admin') {
            const requestsRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'serverJoinRequests', activeServerId, 'users');
            unsubAdmin = onSnapshot(requestsRef, (snap) => {
                setJoinRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            });
        } else {
            setJoinRequests([]);
        }

        // 2. Kullanıcının kendi yaptığı tüm istekleri dinle (Keşfet sayfasında durum göstermek için)
        const myRequestsRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'userJoinRequests', user.uid, 'servers');
        const unsubUser = onSnapshot(myRequestsRef, (snap) => {
            const reqs = {};
            snap.forEach(d => { reqs[d.id] = true; });
            setMyPendingRequests(reqs);
        });

        return () => {
            unsubAdmin();
            unsubUser();
        };
    }, [user, activeServerId, userRole]);

    // Ses Durumu Dinleyicisi
    useEffect(() => {
        if (!user) return;

        const voiceRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence');
        const unsubscribeVoice = onSnapshot(voiceRef, (snapshot) => {
            const now = Date.now();
            const usersInVoice = [];
            snapshot.forEach((doc) => {
                const data = doc.data();
                // Sadece son 150 saniye içinde aktif olanları göster (Heartbeat kontrolü)
                if (data.lastActive && (now - data.lastActive) < 150000) {
                    usersInVoice.push({ userId: doc.id, ...data });
                }
            });
            setVoiceUsers(usersInVoice);

            const myVoiceData = usersInVoice.find(u => u.userId === user.uid);

            // Bildirim Sesi Mantığı: Benim kanalımı filtrele
            if (joinedVoiceChannel) {
                const currentInMyChannel = usersInVoice.filter(u => u.channelId === joinedVoiceChannel && u.userId !== user.uid);
                if (currentInMyChannel.length > prevVoiceInMyChannelRef.current.length) {
                    // Yeni birisi katıldıysa çal
                    playNotificationSound();
                }
                prevVoiceInMyChannelRef.current = currentInMyChannel.map(u => u.userId);
            } else {
                prevVoiceInMyChannelRef.current = [];
            }

            if (!myVoiceData && joinedVoiceChannel !== null) {
                // Eğer veritabanından silinmişsek ama hala kanalda görünüyorsak (başkası bizi attıysa)
                console.log("Sesli kanaldan atıldınız!");
                leaveVoiceChannel(user.uid);
            }
        });

        const handleBeforeUnload = () => {
            if (user) {
                leaveVoiceChannel(user.uid);
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            unsubscribeVoice();
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [user, joinedVoiceChannel]);

    // WebRTC Çağrı Yönetimi
    useEffect(() => {
        if (!joinedVoiceChannel || !peerRef.current || !localStream || !user) return;

        const handleCall = (call) => {
            const streamToUse = localStreamRef.current;
            if (!streamToUse) {
                console.warn("Incoming call but localStreamRef is empty");
                return;
            }
            console.log("Incoming call from peer:", call.peer);
            call.answer(streamToUse);
            call.on('stream', (remoteStream) => {
                addRemoteStream(call.peer, remoteStream);
            });
            call.on('close', () => {
                removeRemoteStream(call.peer);
            });
            callsRef.current[call.peer] = call;
        };

        const peer = peerRef.current;
        peer.on('call', handleCall);

        // Periodic check: Call participants who joined after us
        voiceUsers.forEach(other => {
            if (other.channelId === joinedVoiceChannel && other.userId !== user.uid && other.peerId) {
                if (!callsRef.current[other.peerId] && localStreamRef.current) {
                    console.log("Calling peer:", other.userName);
                    const call = peer.call(other.peerId, localStreamRef.current);
                    if (call) {
                        call.on('stream', (remoteStream) => {
                            addRemoteStream(other.peerId, remoteStream);
                        });
                        call.on('close', () => {
                            removeRemoteStream(other.peerId);
                        });
                        callsRef.current[other.peerId] = call;
                    }
                }
            }
        });

        // Cleanup: remove calls for users who are no longer in our channel
        Object.keys(callsRef.current).forEach(peerId => {
            const stillInChannel = voiceUsers.find(u => u.peerId === peerId && u.channelId === joinedVoiceChannel);
            if (!stillInChannel) {
                if (callsRef.current[peerId]) {
                    callsRef.current[peerId].close();
                    removeRemoteStream(peerId);
                    delete callsRef.current[peerId];
                }
            }
        });

        return () => {
            peer.off('call', handleCall);
        };
    }, [voiceUsers, joinedVoiceChannel, localStream, user?.uid]);

    const joinVoiceChannel = async (channelId) => {
        if (!user) return;
        try {
            if (joinedVoiceChannel) {
                await leaveVoiceChannel();
            }

            // 1. PeerJS Initialization - Standard Cloud Server
            const peer = new Peer(undefined, {
                debug: 1
            });
            peerRef.current = peer;

            // Persistent Connection Management
            peer.on('disconnected', () => {
                console.warn("PeerJS disconnected from signaling server. Attempting to reconnect...");
                if (peerRef.current && !peerRef.current.destroyed) {
                    peerRef.current.reconnect();
                }
            });

            peer.on('error', (err) => {
                console.error("PeerJS Global Error:", err.type, err);
                // Handle specific fatal errors or logging
                if (err.type === 'network' || err.type === 'server-error') {
                    console.log("Potential network issue detected with PeerJS.");
                }
            });

            await getAudioContext().resume();

            // Wait for Peer ID with extended timeout (Initial Connection)
            const peerId = await new Promise((resolve, reject) => {
                const onOpen = (id) => {
                    console.log("PeerJS Connection Successful! Peer ID:", id);
                    peer.off('open', onOpen);
                    peer.off('error', onError);
                    resolve(id);
                };
                const onError = (err) => {
                    console.error("PeerJS Initial Connection Error:", err);
                    peer.off('open', onOpen);
                    peer.off('error', onError);
                    reject(err);
                };

                peer.on('open', onOpen);
                peer.on('error', onError);

                // 20 second timeout for signaling
                setTimeout(() => {
                    peer.off('open', onOpen);
                    peer.off('error', onError);
                    reject(new Error("Sunucuya bağlanılamadı. PeerJS zaman aşımı."));
                }, 20000);
            });

            // --- NATIVE CORE INTEGRATION ---
            if (window.electronAPI && window.electronAPI.audioControl) {
                console.log("Starting Native Core Audio Engine (Sidecar)...");
                window.electronAPI.audioControl.start('127.0.0.1', 50000); 
                window.electronAPI.audioControl.onLog((log) => {
                    if (log.type === 'vad') {
                        handleSpeakingChange(user.uid, log.message === 'speaking');
                    }
                    console.log("[NativeCore]", log.message);
                });
            }

            // 2. Audio Pipeline Setup
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { 
                    noiseSuppression: false, // DISABLE browser noise suppression when using Native Core
                    echoCancellation: true, 
                    autoGainControl: true 
                },
                video: false
            });

            const audioContext = getAudioContext();
            const source = audioContext.createMediaStreamSource(stream);
            const destination = audioContext.createMediaStreamDestination();
            const rnnoiseProcessor = audioContext.createScriptProcessor(1024, 1, 1);

            // High-Performance CIRCULAR Buffering
            const frameSize = 480;
            const inBuffer = new Float32Array(16384);
            const outBuffer = new Float32Array(16384);
            let inHead = 0;
            let inTail = 0;
            let outHead = 0;
            let outTail = 0;
            let prebuffered = false;

            const factory = rnnoiseModuleRef.current;
            console.log("RNNoise Factory State:", !!factory, "Keys:", factory ? Object.keys(factory) : 'none');
            const rnnoiseInstance = (factory && noiseSuppressRef.current) ? await factory.createDenoiseState() : null;
            if (rnnoiseInstance) {
                console.log("RNNoise Instance created (DenoiseState)");
                console.log("Instance Prototype Keys:", Object.keys(Object.getPrototypeOf(rnnoiseInstance)));
            }

            let logCounter = 0;
            rnnoiseProcessor.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                const output = e.outputBuffer.getChannelData(0);

                // 1. Hard Logging - Check signal every ~2 seconds (100 frames)
                logCounter++;
                if (logCounter % 100 === 0) {
                    let sum = 0;
                    for(let i=0; i<input.length; i++) sum += Math.abs(input[i]);
                    const avg = sum / input.length;
                    console.log(`[Voice Heartbeat] Level: ${(avg * 1000).toFixed(4)}, NoiseSuppress: ${noiseSuppressRef.current}, HasInstance: ${!!rnnoiseInstance}, SampleRate: ${audioContext.sampleRate}`);
                }

                // 2. Real-time Bypass or No Instance check
                if (!noiseSuppressRef.current || !rnnoiseInstance) {
                    output.set(input);
                    return;
                }

                // 3. Put input to circular buffer
                for (let i = 0; i < input.length; i++) {
                    inBuffer[inHead % 16384] = input[i];
                    inHead++;
                }

                // 4. Process RNNoise frames (480 samples each)
                while ((inHead - inTail) >= frameSize) {
                    const chunk = new Float32Array(frameSize);
                    for (let i = 0; i < frameSize; i++) {
                        chunk[i] = inBuffer[inTail % 16384];
                        inTail++;
                    }
                    rnnoiseInstance.processFrame(chunk); // Correct method name for 2025.1.5
                    for (let i = 0; i < frameSize; i++) {
                        outBuffer[outHead % 16384] = chunk[i];
                        outHead++;
                    }
                }

                // 5. Fill output (1024 samples pre-buffer to match node size for stability)
                if (!prebuffered && (outHead - outTail) > 1024) prebuffered = true;

                for (let i = 0; i < output.length; i++) {
                    if (prebuffered && (outHead - outTail) > 0) {
                        output[i] = outBuffer[outTail % 16384];
                        outTail++;
                    } else {
                        output[i] = 0;
                        if (prebuffered) {
                            console.warn("[Voice] Buffer Underflow - Resetting prebuffer");
                            prebuffered = false;
                        }
                    }
                }
            };
            audioProcessorRef.current = rnnoiseProcessor;

            // 1. High-Pass Filter (Remove breathing pops and low-end rumble)
            const hpFilter = audioContext.createBiquadFilter();
            hpFilter.type = 'highpass';
            hpFilter.frequency.setValueAtTime(100, audioContext.currentTime);

            // 2. Dynamics Compressor (Limiter/Auto-Gain)
            const compressor = audioContext.createDynamicsCompressor();
            // Soft Compressor: Less aggressive ratio for more natural voice
            compressor.threshold.setValueAtTime(-24, audioContext.currentTime);
            compressor.knee.setValueAtTime(30, audioContext.currentTime);
            compressor.ratio.setValueAtTime(4, audioContext.currentTime); // 4:1 instead of 12:1
            compressor.attack.setValueAtTime(0.003, audioContext.currentTime);
            compressor.release.setValueAtTime(0.25, audioContext.currentTime);

            // 3. Noise Gate (VAD) - Manual Gain control based on volume
            const gateGain = audioContext.createGain();
            gateGain.gain.setValueAtTime(0, audioContext.currentTime); // Start muted

            // 4. Master Gain Boost (Add a bit of warmth/volume)
            const masterGain = audioContext.createGain();
            masterGain.gain.setValueAtTime(1.2, audioContext.currentTime); // 20% boost

            // 5. Analyser for VAD Detection
            const vadAnalyser = audioContext.createAnalyser();
            vadAnalyser.fftSize = 512;
            const dataArray = new Uint8Array(vadAnalyser.frequencyBinCount);

            // FIXED ROUTING: Keep the chain active but bypass RNNoise logic if disabled
            const setupAudioPipeline = () => {
                source.disconnect();
                // Always keep the full chain for VAD and stability, just change internal logic
                source.connect(rnnoiseProcessor);
                rnnoiseProcessor.connect(hpFilter);
                hpFilter.connect(compressor);
                hpFilter.connect(vadAnalyser); // Always connect analyser to HPF for VAD stability
                compressor.connect(gateGain);
                gateGain.connect(masterGain);
                masterGain.connect(destination);
            };

            // Initial Setup
            setupAudioPipeline();

            // Store setup function for real-time toggle
            window._diskort_refreshAudio = setupAudioPipeline;

            // VAD Logic Implementation
            let isSpeakingLocal = false;
            let silenceTimer = null;
            const vadInterval = setInterval(() => {
                vadAnalyser.getByteTimeDomainData(dataArray);
                let maxVal = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const val = Math.abs(dataArray[i] - 128);
                    if (val > maxVal) maxVal = val;
                }

                // Threshold: 1 (Ultra-sensitive to ensure gate opens immediately)
                if (maxVal > 1) {
                    if (silenceTimer) {
                        clearTimeout(silenceTimer);
                        silenceTimer = null;
                    }
                    if (!isSpeakingLocal) {
                        isSpeakingLocal = true;
                        gateGain.gain.setTargetAtTime(1, audioContext.currentTime, 0.05); // Smooth open
                    }
                } else if (isSpeakingLocal && !silenceTimer) {
                    silenceTimer = setTimeout(() => {
                        isSpeakingLocal = false;
                        gateGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.2); // Smooth close
                        silenceTimer = null;
                    }, 400); // 400ms buffer before closing gate
                }
            }, 50);
            audioIntervalRef.current = vadInterval;

            const processedStream = destination.stream;
            localStreamRef.current = processedStream;
            setLocalStream(processedStream);

            // Finalize Firestore Presence
            const userVoiceRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence', user.uid);
            await setDoc(userVoiceRef, {
                userName,
                profilePic: userProfilePic,
                role: userRole,
                channelId,
                peerId: peerId,
                isMuted: isMuted,
                isDeafened: isDeafened,
                lastActive: Date.now(),
                joinedAt: Date.now()
            });

            setJoinedVoiceChannel(channelId);
        } catch (error) {
            console.error("Ses kanalına katılırken hata:", error);
            alert("Bağlantı hatası: " + error.message);
        }
    };

    const leaveVoiceChannel = async (uid = user?.uid) => {
        if (!uid) return;
        try {
            const userVoiceRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence', uid);
            await deleteDoc(userVoiceRef);

            if (uid === user.uid) {
                setJoinedVoiceChannel(null);

                if (localStream) {
                    localStream.getTracks().forEach(track => track.stop());
                    setLocalStream(null);
                }
                localStreamRef.current = null;

                Object.values(callsRef.current).forEach(call => call.close());
                callsRef.current = {};
                setRemoteStreams({});

                if (audioIntervalRef.current) {
                    clearInterval(audioIntervalRef.current);
                    audioIntervalRef.current = null;
                }
                if (audioProcessorRef.current) {
                    audioProcessorRef.current.onaudioprocess = null;
                    audioProcessorRef.current.disconnect();
                    audioProcessorRef.current = null;
                }
                if (peerRef.current) {
                    peerRef.current.destroy();
                    peerRef.current = null;
                }
                
                if (window.electronAPI && window.electronAPI.audioControl) {
                    window.electronAPI.audioControl.stop();
                    console.log("Native Core Audio Engine Stopped.");
                }
            }
        } catch (error) {
            console.error("Ses kanalından ayrılırken hata:", error);
        }
    };

    const handleSendMessage = async (e, imgUrl = null) => {
        if (e) e.preventDefault();
        if (!newMessage.trim() && !imgUrl || !user) return;

        const messageText = newMessage;
        setNewMessage('');

        try {
            // Kanal mesaj sayacını artır (Garantili update)
            const channelRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'channels', activeChannel);
            await setDoc(channelRef, { totalMessages: increment(1) }, { merge: true });

            const messagesRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'messages');
            await addDoc(messagesRef, {
                text: messageText,
                imageUrl: imgUrl,
                channelId: activeChannel,
                serverId: activeServerId,
                userId: user.uid,
                userName: userName,
                profilePic: userProfilePic,
                role: userRole,
                createdAt: Date.now()
            });
        } catch (error) {
            console.error("Mesaj gönderilemedi:", error);
        }
    };



    const handleDeleteMessage = async (messageId, messageUserId) => {
        if (userRole !== 'admin' && !isCeo && user?.uid !== messageUserId) return;
        if (!window.confirm("Bu mesajı silmek istediğinize emin misiniz?")) return;

        try {
            await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'messages', messageId));
        } catch (error) {
            console.error("Mesaj silinemedi:", error);
            showToast('error', 'Mesaj silinemedi.');
        }
    };

    const handleChangeName = async () => {
        const newName = window.prompt("Yeni kullanıcı adınızı girin:", userName);
        if (newName && newName.trim().length > 0) {
            const cleanName = newName.trim();
            setUserName(cleanName);
            if (user) {
                const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
                await setDoc(userDocRef, { name: cleanName }, { merge: true });
            }
        }
    };

    const handleChangePfp = async () => {
        const newPfp = window.prompt("Yeni profil resminizin URL'sini yapıştırın:\n(Sıfırlamak için boş bırakıp iptal et veya tamam deyin)", userProfilePic);
        if (newPfp !== null) {
            const cleanPfp = newPfp.trim();
            setUserProfilePic(cleanPfp);
            if (user) {
                const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
                await setDoc(userDocRef, { photoURL: cleanPfp }, { merge: true });
            }
        }
    };

    const handleLogout = async () => {
        try {
            if (joinedVoiceChannel) {
                await leaveVoiceChannel(user?.uid);
            }
            await signOut(auth);
        } catch (error) {
            console.error("Çıkış hatası:", error);
        }
    };

    const handleUpdateServer = async (e) => {
        if (e) e.preventDefault();
        if (userRole !== 'admin' && !isCeo && activeServer?.ownerId !== user?.uid) {
            showToast('error', 'Sunucu ayarlarını güncellemek için yönetici (admin) olmalısınız.');
            return;
        }
        const trimmedName = serverSettingsName.trim();
        if (!trimmedName) {
            showToast('error', 'Sunucu adı boş olamaz.');
            return;
        }

        setUploadLoading(true);
        try {
            const serverRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', activeServerId);
            const updateData = { name: trimmedName };
            
            // Logo Yükleme (Base64 -> Storage URL)
            if (serverSettingsLogoFile) {
                const logoUrl = await uploadToStorage(serverSettingsLogoFile, `servers/${activeServerId}/logo_${Date.now()}`);
                updateData.logoURL = logoUrl;
            } else {
                updateData.logoURL = serverSettingsLogo.trim();
            }

            // Banner Yükleme (Base64 -> Storage URL)
            if (serverSettingsBannerFile) {
                const bannerUrl = await uploadToStorage(serverSettingsBannerFile, `servers/${activeServerId}/banner_${Date.now()}`);
                updateData.bannerURL = bannerUrl;
            } else {
                updateData.bannerURL = serverSettingsBanner.trim();
            }

            await setDoc(serverRef, updateData, { merge: true });
            setIsServerSettingsModalOpen(false);
            setServerSettingsLogoFile(null);
            setServerSettingsBannerFile(null);
            showToast('success', 'Sunucu ayarları güncellendi.');
        } catch (error) {
            console.error("Sunucu güncelleme hatası:", error);
            window.alert(`GÜNCELLEME HATASI: ${error?.message || error}`);
            showToast('error', `Sunucu güncellenemedi: ${error?.message || 'Bilinmeyen hata'}`);
        } finally {
            setUploadLoading(false);
        }
    };

    const handleDeleteServer = async () => {
        if (userRole !== 'admin' && !isCeo && activeServer?.ownerId !== user?.uid) {
            showToast('error', 'Sunucuyu silmek için yönetici (admin) olmalısınız.');
            return;
        }

        const confirm1 = window.confirm("Bu sunucuyu tamamen silmek istediğinize emin misiniz? (Bu işlem geri alınamaz!)");
        if (!confirm1) return;

        const confirm2 = window.prompt(`Silme işlemini onaylamak için sunucu adını tam olarak girin (${activeServer?.name}):`);
        if (confirm2 !== activeServer?.name) {
            showToast('error', 'Sunucu adı eşleşmedi, silme iptal edildi.');
            return;
        }

        try {
            await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', activeServerId));
            setIsServerSettingsModalOpen(false);
            showToast('success', 'Sunucu başarıyla silindi.');

            // Local state reset and navigate
            navigate('/home');
        } catch (error) {
            console.error("Sunucu silinirken hata:", error);
            showToast('error', 'Sunucu silinemedi.');
        }
    };

    const handleCreateChannel = async (type) => {
        if (userRole !== 'admin' && !isCeo) return;
        const name = window.prompt(`${type === 'text' ? 'Yazı Kanalı' : 'Ses Odası'} adını girin:`);
        if (!name || !name.trim()) return;

        try {
            const channelsRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'channels');
            await addDoc(channelsRef, {
                name: name.trim(),
                serverId: activeServerId, // Sunucuya özel kanal oluştur
                type: type, // Kanal tipini belirt
                totalMessages: 0, // Yeni kanallar için sayaç başlangıcı
                createdBy: user.uid, // Kanalı oluşturan kişi (Atma yetkisi için)
                createdAt: Date.now()
            });
            showToast('success', 'Kanal başarıyla oluşturuldu.');
        } catch (err) {
            console.error("Kanal oluşturma hatası:", err);
            showToast('error', 'Kanal oluşturulamadı.');
        }
    };

    const handleUpdateChannel = async (id, type, currentName) => {
        if (userRole !== 'admin' && !isCeo) return;
        const newName = window.prompt("Yeni kanal adını girin:", currentName);
        if (!newName || !newName.trim() || newName === currentName) return;

        try {
            const channelDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'channels', id);
            await setDoc(channelDocRef, { name: newName.trim() }, { merge: true });
            showToast('success', 'Kanal adı güncellendi.');
        } catch (err) {
            console.error("Kanal güncelleme hatası:", err);
            showToast('error', 'Kanal güncellenemedi.');
        }
    };

    const handleDeleteChannel = async (id, type, name) => {
        if (userRole !== 'admin' && !isCeo) return;
        if (!window.confirm(`"${name}" kanalını silmek istediğinize emin misiniz? Tüm mesajlar da silinecektir.`)) return;

        try {
            const channelDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'channels', id);
            await deleteDoc(channelDocRef);
            showToast('success', 'Kanal silindi.');
            if (channelId === id) {
                navigate(`/${activeServerId}`);
            }
        } catch (err) {
            console.error("Kanal silme hatası:", err);
            showToast('error', 'Kanal silinemedi.');
        }
    };

    const handleKickVoice = async (targetUserId) => {
        const targetVoiceUser = voiceUsers.find(vu => vu.userId === targetUserId);
        const targetChannel = channels.find(c => c.id === targetVoiceUser?.channelId);

        // Admin VEYA Kanal Sahibi VEYA Ceo atabilir
        const canKick = userRole === 'admin' || isCeo || (targetChannel && targetChannel.createdBy === user.uid);

        if (!canKick) {
            showToast('error', 'Bu kullanıcıyı sesten atma yetkiniz yok.');
            return;
        }

        if (!window.confirm("Bu kullanıcıyı ses kanalından atmak istediğinize emin misiniz?")) return;

        try {
            const voiceDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence', targetUserId);
            await deleteDoc(voiceDocRef);
            showToast('success', 'Kullanıcı sesten atıldı.');
            setProfileUserModal(null);
        } catch (err) {
            console.error("Sesten atma hatası:", err);
            showToast('error', 'Sesten atılamadı.');
        }
    };

    const handleKickServer = async (targetUserId) => {
        if (userRole !== 'admin' && !isCeo) return;
        if (!window.confirm("Bu kullanıcıyı sunucudan tamamen silmek istediğinize emin misiniz?")) return;

        try {
            // DİKKAT: Global kullanıcıyı DEĞİL, sadece bu sunucudaki üyeliğini siliyoruz
            const memberDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', activeServerId, 'users', targetUserId);
            await deleteDoc(memberDocRef);

            // Ayrıca sesten de atalım
            const voiceDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'voice_presence', targetUserId);
            await deleteDoc(voiceDocRef);

            // Üye sayısını azalt
            const serverRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', activeServerId);
            await setDoc(serverRef, { memberCount: increment(-1) }, { merge: true });

            showToast('success', 'Kullanıcı sunucudan atıldı.');
            setProfileUserModal(null);
            setSelectedUserForRole(null);
        } catch (err) {
            console.error("Sunucudan atma hatası:", err);
            showToast('error', 'Sunucudan atılamadı.');
        }
    };

    const handleUpdateUserRole = async (targetUserId, newRole) => {
        if (userRole !== 'admin' && userRole !== 'moderator' && !isCeo) return;

        try {
            const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', activeServerId, 'users', targetUserId);
            await setDoc(userDocRef, { role: newRole }, { merge: true });

            // Pokud profil modalı açıksa onun da rolünü güncelle
            if (profileUserModal && profileUserModal.id === targetUserId) {
                setProfileUserModal(prev => prev ? { ...prev, role: newRole } : null);
            }
            // Rol yönetimi modalını da anında güncelle
            if (selectedUserForRole && selectedUserForRole.id === targetUserId) {
                setSelectedUserForRole(prev => prev ? { ...prev, currentRole: newRole } : null);
            }
        } catch (err) {
            console.error("Rol güncellenirken hata:", err);
            showToast('error', 'Rol güncellenemedi.');
        }
    };

    const handleCreateRole = async (e) => {
        e.preventDefault();
        if (userRole !== 'admin' && userRole !== 'moderator' && !isCeo) return;
        if (!newRoleName.trim()) return;

        try {
            const rolesRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'roles');
            await addDoc(rolesRef, { name: newRoleName.trim(), color: newRoleColor });
            setNewRoleName('');
            showToast('success', 'Özel rol oluşturuldu!');
        } catch (err) {
            console.error("Rol oluşturulurken hata:", err);
            showToast('error', 'Rol oluşturulamadı.');
        }
    };

    const handleToggleCustomRole = async (targetUserId, roleId) => {
        if (userRole !== 'admin' && userRole !== 'moderator' && !isCeo) return;
        const targetUser = allUsers.find(u => u.id === targetUserId);
        if (!targetUser) return;

        let currentCustomRoles = targetUser.customRoles || [];
        if (currentCustomRoles.includes(roleId)) {
            currentCustomRoles = currentCustomRoles.filter(id => id !== roleId);
        } else {
            currentCustomRoles = [...currentCustomRoles, roleId];
        }

        try {
            const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', activeServerId, 'users', targetUserId);
            await setDoc(userDocRef, { customRoles: currentCustomRoles }, { merge: true });

            // Modal verisini locale olarak anında güncelle
            setSelectedUserForRole(prev => ({ ...prev, customRoles: currentCustomRoles }));
        } catch (err) {
            console.error("Özel rol güncellenirken hata:", err);
            showToast('error', 'Rol güncellenemedi.');
        }
    };

    const handleDeleteRole = async (roleId) => {
        if (userRole !== 'admin' && userRole !== 'moderator') return;
        if (!window.confirm("Bu rolü tamamen silmek istediğinize emin misiniz?")) return;

        try {
            await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'roles', roleId));
            showToast('success', 'Rol silindi.');
        } catch (err) {
            console.error("Rol silinirken hata:", err);
            showToast('error', 'Rol silinemedi.');
        }
    };

    const handleClearChannel = async () => {
        if (userRole !== 'admin') return;
        const channelName = channels.find(c => c.id === activeChannel)?.name || activeChannel;
        if (!window.confirm(`"${channelName}" kanalındaki TÜM mesajları silmek istediğinize emin misiniz? Bu işlem geri alınamaz!`)) return;

        try {
            showToast('info', 'Kanal temizleniyor...');
            const messagesRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'messages');
            const q = query(messagesRef, where('channelId', '==', activeChannel));
            const snapshot = await new Promise((resolve, reject) => {
                const unsub = onSnapshot(q, (snap) => { unsub(); resolve(snap); }, reject);
            });

            const deletePromises = snapshot.docs.map(d => deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'messages', d.id)));
            await Promise.all(deletePromises);
            showToast('success', `Kanal temizlendi! (${snapshot.docs.length} mesaj silindi)`);
        } catch (err) {
            console.error('Kanal temizlenirken hata:', err);
            showToast('error', 'Kanal temizlenemedi!');
        }
    };

    const toastTimeoutRef = useRef(null);
    const compressImage = (file, maxW, maxH, quality = 0.75) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const reader = new FileReader();
            reader.onload = (ev) => {
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let w = img.width, h = img.height;
                    const ratio = Math.min(maxW / w, maxH / h, 1);
                    w = Math.round(w * ratio);
                    h = Math.round(h * ratio);
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = () => reject(new Error("Görüntü yüklenirken bir hata oluştu."));
                img.src = ev.target.result;
            };
            reader.onerror = () => reject(new Error("Dosya okunurken bir hata oluştu."));
            reader.readAsDataURL(file);
        });
    };

    // Helper to upload base64 to ImgBB (Replaces Firebase Storage)
    const uploadToStorage = async (base64, path) => {
        try {
            console.log("Upload başlatılıyor (ImgBB). Veri boyutu:", base64?.length);
            if (!base64 || !base64.startsWith('data:image')) {
                throw new Error("Geçersiz resim formatı! Resim 'data:image' ile başlamıyor.");
            }
            
            // Extract the pure base64 string (remove "data:image/jpeg;base64,")
            const base64Data = base64.split(',')[1];
            
            // ImgBB API Key provided by the user
            const IMGBB_API_KEY = "afdd910baf4a82f20de4b5b762db0659"; 
            
            const formData = new FormData();
            formData.append('image', base64Data);
            
            const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Return the direct display URL from ImgBB
                return data.data.url;
            } else {
                throw new Error(data.error?.message || "ImgBB yükleme başarısız oldu.");
            }
            
        } catch (error) {
            console.error("ImgBB upload error:", error);
            window.alert(`UPLOAD ERROR: ${error.message}`);
            throw new Error(`Depolama başarısız: ${error.message}`);
        }
    };

    const handleFileUpload = async (e, type) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';

        // GLOBAL 15MB LİMİTİ
        if (file.size > 15 * 1024 * 1024) {
            showToast('error', 'Dosya çok büyük! Maksimum 15MB yükleyebilirsiniz.');
            return;
        }

        if (!file.type.startsWith('image/')) {
            showToast('error', 'Lütfen bir resim dosyası seçin!');
            return;
        }

        // Önizlemeler için global loading gösterme, sadece chat/pfp için göster
        const isPreview = ['serverLogo', 'serverSettingsLogo', 'serverSettingsBanner'].includes(type);
        if (!isPreview) {
            setUploadLoading(true);
            showToast('info', 'Dosya sunucuya yükleniyor...');
        } else {
            showToast('info', 'Görsel işleniyor...');
        }

        try {
            let finalData;
            const isGif = file.type === 'image/gif';

            if (isGif) {
                // GIF için boyut kontrolü - 15MB limiti (Base64 boyutu %33 artar)
                if (file.size > 15 * 1024 * 1024) {
                    showToast('error', 'GIF çok büyük! Lütfen 15MB altı bir dosya seçin.');
                    setUploadLoading(false);
                    return;
                }

                finalData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (ev) => resolve(ev.target.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            } else {
                // Statik resimler için sıkıştır. Bannerlar için daha yüksek çözünürlük veriyoruz.
                const isBanner = type.toLowerCase().includes('banner');
                const maxWidth = isBanner ? 1920 : ((type === 'chat' || type === 'dm') ? 1280 : 500);
                const maxHeight = isBanner ? 1080 : ((type === 'chat' || type === 'dm') ? 1280 : 500);
                finalData = await compressImage(file, maxWidth, maxHeight, 0.85);
            }

            if (type === 'serverLogo') {
                setNewServerLogo(finalData);
                showToast('success', 'Logo önizlemesi hazır! ✨');
                setUploadLoading(false);
                return;
            }

            if (type === 'serverSettingsLogo') {
                setServerSettingsLogoFile(finalData);
                showToast('success', 'Logo önizlemesi hazır! ✨');
                setUploadLoading(false);
                return;
            }

            if (type === 'serverSettingsBanner') {
                setServerSettingsBannerFile(finalData);
                showToast('success', 'Banner önizlemesi hazır! ✨');
                setUploadLoading(false);
                return;
            }

            if (type === 'chat') {
                const timestamp = Date.now();
                const storageUrl = await uploadToStorage(finalData, `chat/${activeChannel}/${timestamp}`);
                await handleSendMessage(null, storageUrl);
                showToast('success', 'Resim gönderildi! 🖼️');
            } else if (type === 'dm') {
                const timestamp = Date.now();
                const convId = getDmConvId(user.uid, activeDM.friendId);
                const storageUrl = await uploadToStorage(finalData, `dm/${convId}/${timestamp}`);
                await sendDM(null, storageUrl);
                showToast('success', 'Resim gönderildi! 🖼️');
            } else {
                const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
                const updateObj = {};

                if (type === 'pfp') {
                    const storageUrl = await uploadToStorage(finalData, `profiles/${user.uid}/pfp_${Date.now()}`);
                    updateObj.photoURL = storageUrl;
                    setUserProfilePic(storageUrl);
                    setProfileUserModal(prev => prev ? { ...prev, photoURL: storageUrl } : null);
                }
                if (type === 'banner') {
                    const storageUrl = await uploadToStorage(finalData, `profiles/${user.uid}/banner_${Date.now()}`);
                    updateObj.bannerURL = storageUrl;
                    setProfileUserModal(prev => prev ? { ...prev, bannerURL: storageUrl } : null);
                }

                await setDoc(userDocRef, updateObj, { merge: true });
                showToast('success', type === 'pfp' ? 'Profil resmi güncellendi! ✨' : 'Banner güncellendi! ✨');
            }
        } catch (err) {
            console.error('Yükleme hatası:', err);
            showToast('error', `Yüklenemedi: ${err.message}`);
        } finally {
            setUploadLoading(false);
        }
    };


    const handleCreateServer = async (name, logo = null, isAuto = false, explicitOwnerId = null, explicitOwnerName = null) => {
        const ownerId = explicitOwnerId || user?.uid;
        const ownerName = explicitOwnerName || userName;
        if (!ownerId) return;

        const serverName = name || newServerName;
        const serverLogo = logo || newServerLogo;

        if (!serverName.trim()) {
            showToast('error', 'Lütfen bir sunucu ismi girin!');
            return;
        }

        setUploadLoading(true);
        try {
            const inviteCode = Math.random().toString(36).substring(2, 9).toUpperCase();
            const serversRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'servers');
            
            let finalLogoURL = serverLogo || '';
            if (serverLogo && serverLogo.startsWith('data:')) {
                // Eğer yeni bir logo yüklendiyse (base64 ise), Storage'a atalım
                finalLogoURL = await uploadToStorage(serverLogo, `servers/temp/logo_${Date.now()}`);
            }

            const serverDoc = await addDoc(serversRef, {
                name: serverName,
                logoURL: finalLogoURL,
                ownerId: ownerId,
                inviteCode: inviteCode,
                createdAt: Date.now(),
                memberCount: 1
            });

            // Eğer logoyu temp altına attıysak şimdi sunucu ID'siyle güncelleyebiliriz (opsiyonel ama düzenli olur)
            // Şimdilik temp linki kalsın, sorun değil.

            // 1. Üyeliği Kaydet (Kullanıcı dökümanı altında)
            const myMembershipRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'memberships', ownerId, 'servers', serverDoc.id);
            await setDoc(myMembershipRef, { joinedAt: Date.now() });

            // 2. Sunucu Üye Listesine Ekle (Sunucu dökümanı altında)
            const serverMemberRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', serverDoc.id, 'users', ownerId);
            const myData = allUsers.find(u => u.id === ownerId);
            await setDoc(serverMemberRef, {
                id: ownerId,
                name: myData?.name || myData?.userName || ownerName,
                photoURL: myData?.photoURL || userProfilePic || '',
                role: 'admin',
                joinedAt: Date.now()
            });

            // Varsayılan kanalları oluştur
            const channelsRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'channels');
            const genText = await addDoc(channelsRef, {
                name: 'genel-sohbet',
                serverId: serverDoc.id,
                type: 'text', // Tip eklendi
                totalMessages: 0, // Başlangıç sayacı eklendi
                createdAt: Date.now()
            });

            await addDoc(channelsRef, {
                name: 'Genel Ses',
                serverId: serverDoc.id,
                type: 'voice', // Tip eklendi
                createdAt: Date.now()
            });

            if (!isAuto) {
                showToast('success', 'Sunucu başarıyla oluşturuldu! 🎉');
                setIsCreateServerModalOpen(false);
                setNewServerName('');
                setNewServerLogo('');
                navigate(`/${serverDoc.id}/${genText.id}`);
            } else {
                if (activeServerId === 'home') {
                    navigate(`/${serverDoc.id}/${genText.id}`);
                }
            }
        } catch (err) {
            console.error('Sunucu oluşturma hatası:', err);
            showToast('error', 'Sunucu oluşturulamadı: ' + (err.message || 'Bilinmeyen hata'));
        } finally {
            setUploadLoading(false);
            // Eğer modal hala açıksa ve yükleme bitmişse (hata durumunda da)
            // Kullanıcının butona tekrar basabilmesini sağlıyoruz
        }
    };

    const handleJoinServer = async () => {
        if (!user || !inviteInput.trim()) return;

        setUploadLoading(true);
        try {
            const inviteCodeNormalized = inviteInput.trim().toUpperCase();
            // kodu bulmak için onSnapshot yerine getDocs kullanımı bu tip tekil işlemler için daha temizdir
            const serversRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'servers');
            const q = query(serversRef, where('inviteCode', '==', inviteCodeNormalized));
            const querySnapshot = await getDocs(q);

            if (querySnapshot.empty) {
                showToast('error', 'Geçersiz davet kodu.');
                setUploadLoading(false);
                return;
            }

            const serverDoc = querySnapshot.docs[0];
            const serverId = serverDoc.id;

            // 1. Üyeliği Kaydet (Kullanıcı dökümanı altında)
            const myMembershipRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'memberships', user.uid, 'servers', serverId);
            await setDoc(myMembershipRef, { joinedAt: Date.now() });

            // 2. Sunucu Üye Listesine Ekle (Sunucu dökümanı altında)
            const serverMemberRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', serverId, 'users', user.uid);
            const myData = allUsers.find(u => u.id === user.uid);
            await setDoc(serverMemberRef, {
                id: user.uid,
                name: myData?.name || myData?.userName || userName,
                photoURL: myData?.photoURL || userProfilePic || '',
                role: 'user',
                joinedAt: Date.now()
            });

            // Üye sayısını artır
            const serverRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', serverId);
            await setDoc(serverRef, { memberCount: increment(1) }, { merge: true });

            showToast('success', `${serverDoc.data().name} sunucusuna katıldınız! 🎉`);
            setIsCreateServerModalOpen(false);
            setInviteInput('');
            setServerModalView('selection');
            navigate(`/${serverId}`);
        } catch (err) {
            console.error('Join server error:', err);
            showToast('error', 'Sunucuya katılırken bir hata oluştu.');
        } finally {
            setUploadLoading(false);
        }
    };

    const handleJoinRequest = async (serverId, serverName) => {
        if (!user) return;
        try {
            // 1. Admin/Sunucu bazlı istek (Server-side management için)
            const requestRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'serverJoinRequests', serverId, 'users', user.uid);
            await setDoc(requestRef, {
                userId: user.uid,
                userName: userName,
                profilePic: userProfilePic,
                createdAt: Date.now()
            });

            // 2. Kullanıcı bazlı istek (UI'da buton durumunu hemen güncellemek için)
            const myRequestRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'userJoinRequests', user.uid, 'servers', serverId);
            await setDoc(myRequestRef, {
                serverId: serverId,
                serverName: serverName,
                createdAt: Date.now()
            });

            showToast('success', `${serverName} sunucusuna katılım isteği gönderildi!`);
        } catch (err) {
            console.error('Join request error:', err);
            showToast('error', 'İstek gönderilemedi.');
        }
    };

    const handleApproveJoinRequest = async (requestId, reqData) => {
        if (userRole !== 'admin') return;
        try {
            // 1. Üyeliği Kaydet (Kullanıcı dökümanı altında)
            const myMembershipRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'memberships', requestId, 'servers', activeServerId);
            await setDoc(myMembershipRef, { joinedAt: Date.now() });

            // 2. Sunucu Üye Listesine Ekle (Sunucu dökümanı altında)
            const serverMemberRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', activeServerId, 'users', requestId);
            await setDoc(serverMemberRef, {
                id: requestId,
                name: reqData.userName,
                photoURL: reqData.profilePic || '',
                role: 'user',
                joinedAt: Date.now()
            });

            // 3. İstekleri Sil
            await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'serverJoinRequests', activeServerId, 'users', requestId));
            await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'userJoinRequests', requestId, 'servers', activeServerId));

            // Üye sayısını artır
            const serverRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', activeServerId);
            await setDoc(serverRef, { memberCount: increment(1) }, { merge: true });

            showToast('success', 'İstek onaylandı.');
        } catch (err) {
            console.error('Approve request error:', err);
            showToast('error', 'İstek onaylanamadı.');
        }
    };

    const handleDeclineJoinRequest = async (requestId, reqData) => {
        if (userRole !== 'admin') return;
        try {
            await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'serverJoinRequests', activeServerId, 'users', requestId));
            await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'userJoinRequests', requestId, 'servers', activeServerId));
            showToast('info', 'İstek reddedildi.');
        } catch (err) {
            console.error('Decline request error:', err);
            showToast('error', 'İstek reddedilemedi.');
        }
    };

    const handleLeaveServer = async () => {
        if (!user || !activeServerId || activeServerId === 'home') return;
        
        // Owner Check
        if (activeServer?.ownerId === user.uid) {
            showToast('error', 'Sunucu sahibi sunucudan ayrılamaz. Lütfen sunucuyu silin.');
            return;
        }

        if (!window.confirm(`${activeServer?.name} sunucusundan ayrılmak istediğinize emin misiniz?`)) return;

        try {
            // 1. Üyeliği Sil (Kullanıcı dökümanı altından)
            const myMembershipRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'memberships', user.uid, 'servers', activeServerId);
            await deleteDoc(myMembershipRef);

            // 2. Sunucu Üye Listesinden Sil
            const serverMemberRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'server_members', activeServerId, 'users', user.uid);
            await deleteDoc(serverMemberRef);

            // 3. Eğer seste ise sesten ayrıl
            if (joinedVoiceChannel) {
                await leaveVoiceChannel();
            }

            // Üye sayısını azalt
            const serverRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'servers', activeServerId);
            await setDoc(serverRef, { memberCount: increment(-1) }, { merge: true });

            showToast('success', `${activeServer?.name} sunucusundan ayrıldınız.`);
            navigate('/home');
        } catch (err) {
            console.error('Leave server error:', err);
            showToast('error', 'Sunucudan ayrılamadı.');
        }
    };

    const toggleGameSelection = async (gameId) => {
        const fullUser = allUsers.find(u => u.id === user.uid);
        const currentGames = fullUser?.favoriteGames || [];

        let newGames;
        if (currentGames.includes(gameId)) {
            newGames = currentGames.filter(id => id !== gameId); // Remove
        } else {
            if (currentGames.length >= 4) {
                showToast('error', 'En fazla 4 oyun seçebilirsiniz.');
                return;
            }
            newGames = [...currentGames, gameId]; // Add
        }

        const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
        await setDoc(userDocRef, { favoriteGames: newGames }, { merge: true });
    };

    const handleSaveStatus = async () => {
        const statusToSave = (tempStatus || "").substring(0, 25).trim();
        if (!user || statusToSave === '') {
            setEditingStatus(false);
            return;
        }
        try {
            const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
            await setDoc(userDocRef, { statusText: statusToSave }, { merge: true });
        } catch (error) {
            console.error("Status kaydetme hatası:", error);
        } finally {
            setEditingStatus(false);
        }
    };

    const handleUpdateProfile = async (type) => {
        if (type === 'name') {
            const newValue = window.prompt("Yeni adınızı girin:", userName);
            if (newValue !== null && newValue.trim()) {
                const cleanValue = newValue.trim();
                const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
                await setDoc(userDocRef, { name: cleanValue }, { merge: true });
                setUserName(cleanValue);
                // Modal'ı kapatmak yerine içeriğini güncelle
                setProfileUserModal(prev => prev ? { ...prev, name: cleanValue } : null);
                showToast('success', 'İsim güncellendi!');
            }
            return;
        }

        // For pfp and banner, trigger file inputs
        if (type === 'pfp' && pfpInputRef.current) pfpInputRef.current.click();
        if (type === 'banner' && bannerInputRef.current) bannerInputRef.current.click();
    };

    // Arkadaş İşlevleri
    const sendFriendRequest = async (targetId) => {
        if (!user || targetId === user.uid) return;
        const targetUser = allUsers.find(u => u.id === targetId);
        const myUser = allUsers.find(u => u.id === user.uid);
        // Bana gönder: hedefin incoming kısmına yaz
        await setDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', targetId, 'incoming', user.uid), {
            senderId: user.uid,
            senderName: myUser?.name || myUser?.userName || userName,
            senderPhotoURL: myUser?.photoURL || userProfilePic || '',
            sentAt: Date.now()
        });
        // Benim outgoing kısmıma yaz
        await setDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', user.uid, 'outgoing', targetId), {
            targetId,
            targetName: targetUser?.name || targetUser?.userName || '',
            sentAt: Date.now()
        });
        showToast('success', 'Arkadaşlık isteği gönderildi!');
    };

    const acceptFriendRequest = async (senderId) => {
        if (!user) return;
        const senderData = incomingRequests.find(r => r.id === senderId);
        const myUser = allUsers.find(u => u.id === user.uid);
        // Her iki tarafa friends ekle
        await setDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friends', user.uid, 'list', senderId), {
            friendId: senderId,
            friendName: senderData?.senderName || '',
            friendPhotoURL: senderData?.senderPhotoURL || '',
            addedAt: Date.now()
        });
        await setDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friends', senderId, 'list', user.uid), {
            friendId: user.uid,
            friendName: myUser?.name || myUser?.userName || userName,
            friendPhotoURL: myUser?.photoURL || userProfilePic || '',
            addedAt: Date.now()
        });
        // İstekleri temizle
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', user.uid, 'incoming', senderId));
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', senderId, 'outgoing', user.uid));
        showToast('success', 'Arkadaş eklendi!');
    };

    const rejectFriendRequest = async (senderId) => {
        if (!user) return;
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', user.uid, 'incoming', senderId));
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friendRequests', senderId, 'outgoing', user.uid));
        showToast('success', 'İstek reddedildi.');
    };

    const removeFriend = async (friendId) => {
        if (!user) return;
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friends', user.uid, 'list', friendId));
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'friends', friendId, 'list', user.uid));
        showToast('success', 'Arkadaşlıktan çıkarıldı.');
    };

    // ---- DM Yardımcı Fonksiyonları ----
    const getDmConvId = (a, b) => [a, b].sort().join('_');

    const openDMWith = (friend) => {
        setActiveDM(friend);
        setShowDMs(true);
        setShowFriends(false);
        const convId = getDmConvId(user.uid, friend.friendId);
        markDMRead(convId);
    };

    const markDMRead = async (convId) => {
        if (!user) return;
        const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'dmUnread', user.uid, 'convs', convId);
        await setDoc(ref, { count: 0 }, { merge: true });
    };

    const sendDM = async (e, imgUrl = null) => {
        if (e) e.preventDefault();
        if (!dmInput.trim() && !imgUrl || !activeDM || !user) return;
        const convId = getDmConvId(user.uid, activeDM.friendId);
        const msgRef = collection(db, 'artifacts', APP_ID, 'public', 'data', 'directMessages', convId, 'messages');
        const myData = allUsers.find(u => u.id === user.uid);
        await addDoc(msgRef, {
            text: dmInput.trim(),
            imageUrl: imgUrl,
            senderId: user.uid,
            senderName: myData?.name || myData?.userName || userName,
            senderPhotoURL: myData?.photoURL || userProfilePic || '',
            createdAt: Date.now()
        });
        setDmInput('');
        // Karşı tarafin unread sayacını artır (Firestore increment kullanarak okuma işleminden tasarruf)
        const theirRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'dmUnread', activeDM.friendId, 'convs', convId);
        await setDoc(theirRef, { count: increment(1), fromId: user.uid, fromName: myData?.name || myData?.userName || userName }, { merge: true });
        setDmInput('');
    };

    const StatusBadge = ({ role, currentUser }) => {
        const isUserCeo = currentUser?.email === 'merttekinler07@gmail.com';
        if (isUserCeo) return <span className="ml-1.5 text-[8px] bg-[#fbbc05]/20 text-[#fbbc05] px-1.5 py-0.5 rounded border border-[#fbbc05]/30 font-black tracking-tighter shadow-[0_0_8px_rgba(251,188,5,0.3)] animate-pulse whitespace-nowrap uppercase">CEO</span>;
        if (role === 'admin') return <span className="ml-1.5 text-[8px] bg-red-500/20 text-red-500 px-1.5 py-0.5 rounded border border-red-500/30 font-black tracking-tighter whitespace-nowrap uppercase">Admin</span>;
        if (role === 'moderator') return <span className="ml-1.5 text-[8px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded border border-purple-500/20 font-black tracking-tighter whitespace-nowrap uppercase">Yetkili</span>;
        return <span className="ml-1.5 text-[8px] bg-slate-500/10 text-slate-400 px-1.5 py-0.5 rounded border border-slate-500/20 font-black tracking-tighter whitespace-nowrap uppercase">Üye</span>;
    };


    // Geçersiz veya erişilemeyen sunucu adresi yönlendirmesi
    useEffect(() => {
        if (isServersLoaded && activeServerId !== 'home' && !activeServer && !isCeo) {
            showToast('error', 'Sunucu bulunamadı veya erişim izniniz yok. Ana sayfaya yönlendiriliyorsunuz.');
            navigate('/home', { replace: true });
        }
    }, [isServersLoaded, activeServerId, activeServer, navigate]);

    if (loading || minLoading || (user && !isServersLoaded)) {
        return (
            <div className="flex h-screen items-center justify-center bg-[#020202] text-white flex-col relative overflow-hidden">
                {/* Advanced Animated Background Orbs */}
                <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[120px] animate-orb-1"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-purple-600/20 rounded-full blur-[120px] animate-orb-2"></div>
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.05)_0%,transparent_70%)] pointer-events-none"></div>

                <div className="relative flex flex-col items-center animate-fade-in-up">
                    {/* Pure Logo with Aura Animation */}
                    <div className="relative mb-8 group flex items-center justify-center">
                        {/* Dynamic Aura Rings */}
                        <div className="absolute w-40 h-40 bg-indigo-500/30 rounded-full animate-logo-aura"></div>
                        
                        <div className="relative w-32 h-32 flex items-center justify-center">
                            <img
                                src="./logo.png"
                                className="w-24 h-24 object-contain animate-float drop-shadow-[0_0_40px_rgba(99,102,241,1)]"
                                alt="Mekanda Logo"
                                onError={(e) => { e.target.style.display = 'none'; }}
                            />
                        </div>
                    </div>

                    {/* Typography & Brand */}
                    <div className="flex flex-col items-center mb-12 z-10 text-center">
                        <div className="relative">
                            <span className="text-6xl font-black bg-gradient-to-br from-white via-indigo-200 to-purple-400 bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(99,102,241,0.4)] mb-2 block animate-letter-gather">
                                MEKANDA
                            </span>
                        </div>
                    </div>

                    {/* Sophisticated Loading Status - Premium Redesign */}
                    <div className="flex flex-col items-center space-y-6">
                        <div className="relative flex flex-col items-center">
                            <div className="flex items-center space-x-6 mb-4">
                                <span className="text-[10px] font-black text-indigo-300/60 tracking-[0.8em] uppercase pl-1">MEKAN YÜKLENİYOR</span>
                            </div>
                            
                            {/* Premium Progress Bar */}
                            <div className="w-64 h-[3px] bg-white/5 rounded-full overflow-hidden relative border border-white/5">
                                <div className="absolute top-0 left-0 h-full w-1/3 bg-gradient-to-r from-transparent via-indigo-400 to-transparent animate-[shimmer_4s_ease-in-out_infinite] shadow-[0_0_15px_rgba(129,140,248,0.8)]"></div>
                                <div className="absolute top-0 left-0 h-full w-full bg-indigo-500/10 animate-pulse"></div>
                            </div>
                            {/* Glow removed */}
                        </div>

                        {forceLoad && (
                            <div className="animate-fade-in py-2 px-6 rounded-lg bg-indigo-500/5 border border-indigo-500/10">
                                <p className="text-[9px] font-bold text-indigo-300/40 uppercase tracking-[0.4em] text-center">
                                    Bağlanma Süreci Uzuyor...
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Author Credit - Premium Copyright Style */}
                <div className="absolute bottom-10 w-full text-center opacity-40 animate-fade-in [animation-delay:1s]">
                    <p className="text-[9px] font-black text-indigo-200/30 tracking-[0.5em] uppercase pl-1">
                        MERT TEKİNLER TARAFINDAN TASARLANMIŞTIR
                    </p>
                </div>
            </div>
        );
    }

    if (!user) {
        return <Auth />;
    }

    return (
        <div className="flex flex-col h-screen bg-[#0a0a0c] text-slate-200 font-sans overflow-hidden selection:bg-indigo-500/30">
            {/* Custom Title Bar for Frameless Electron Window - Only show in Electron */}
            {window.electronAPI && <TitleBar />}
            
            <div className="flex flex-1 overflow-hidden relative mesh-bg">
                {/* Arka plan süslemeleri */}
                <div className="fixed top-0 left-0 w-full h-full pointer-events-none z-0">
                    <div className="absolute top-[-10%] right-[-10%] w-[600px] h-[600px] bg-indigo-600/10 rounded-full blur-[120px]"></div>
                    <div className="absolute bottom-[-10%] left-[-10%] w-[600px] h-[600px] bg-purple-600/5 rounded-full blur-[120px]"></div>
                </div>


            {/* Ultra-Left Sidebar (Sunucu Listesi) */}
            <nav className="w-[72px] bg-[#020202] flex flex-col items-center py-3 space-y-2.5 z-[60] border-r border-white/5 overflow-y-auto custom-scrollbar no-scrollbar">
                {/* Home Button */}
                <button
                    onClick={() => {
                        navigate('/home');
                        setShowDiscovery(true);
                        setShowFriends(false);
                        setShowDMs(false);
                        setIsSidebarOpen(false);
                    }}
                    className={`group relative flex items-center justify-center w-12 h-12 transition-all duration-500`}
                    title="Ana Sayfa"
                >
                    <div className="w-12 h-12 flex items-center justify-center transition-all duration-500 transform group-hover:rotate-[360deg] group-active:scale-95 relative">
                        <img src="./logo.png" className="w-full h-full object-contain" alt="Ana Sayfa" />
                        
                        {Object.values(dmUnreadCounts).some(count => count > 0) ? (
                            <div className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-1 border-2 border-[#020202] z-10 animate-bell-shake shadow-[0_0_10px_rgba(239,68,68,0.6)]">
                                <MessageSquare size={10} fill="currentColor" />
                            </div>
                        ) : incomingRequests.length > 0 ? (
                            <div className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-1 border-2 border-[#020202] z-10 animate-bell-shake shadow-[0_0_10px_rgba(239,68,68,0.6)]">
                                <Users size={10} fill="currentColor" />
                            </div>
                        ) : null}
                    </div>
                </button>

                <div className="w-8 h-[2px] bg-white/10 rounded-full mx-auto my-1"></div>

                {/* Server Icons */}
                {servers.map((srv) => (
                    <button
                        key={srv.id}
                        onClick={() => {
                            navigate(`/${srv.id}`);
                            setIsSidebarOpen(false);
                            setShowDiscovery(false);
                        }}
                        className={`group relative flex items-center justify-center w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all duration-300 overflow-hidden ${activeServerId === srv.id ? 'bg-indigo-500 text-white rounded-[16px]' : 'bg-white/5 text-slate-300 hover:bg-indigo-500'}`}
                        title={srv.name}
                    >
                        <div className={`absolute left-0 w-1 bg-[#10b981] rounded-r-full transition-all duration-300 ${activeServerId === srv.id ? 'h-10' : 'h-0 group-hover:h-4'}`}></div>
                        {activeServerId === srv.id && <div className="active-server-ring"></div>}
                        {srv.logoURL ? (
                            <img src={srv.logoURL} className="w-full h-full object-cover" alt={srv.name} />
                        ) : (
                            <span className="text-sm font-black">{srv.name.substring(0, 2)}</span>
                        )}
                    </button>
                ))}

                {/* Add Server Button */}
                <button
                    onClick={() => setIsCreateServerModalOpen(true)}
                    className="group relative flex items-center justify-center w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all duration-300 bg-white/5 text-emerald-500 hover:bg-emerald-500 hover:text-white"
                    title="Sunucu Ekle"
                >
                    <Plus size={24} />
                </button>
            </nav>

            <aside className={`
        ${activeServerId === 'home' && !isSidebarOpen ? 'hidden md:flex' : 'flex'}
        fixed md:static inset-y-0 left-[72px] md:left-0 z-50 w-72 premium-sidebar flex flex-col transition-all duration-500 ease-in-out
        ${isSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full md:translate-x-0'}
      `}>
                <header className={`relative transition-all duration-500 shrink-0 ${activeServer?.bannerURL ? 'h-40' : 'h-16'} border-b border-white/5 backdrop-blur-md bg-white/[0.02] flex flex-col overflow-hidden group/header-main`}>
                    {activeServer?.bannerURL && (
                        <div className="absolute inset-0 z-0">
                            <img src={activeServer.bannerURL} className="w-full h-full object-cover opacity-80 group-hover/header-main:scale-110 transition-transform duration-1000" alt="" />
                            <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0c] via-[#0a0a0c]/40 to-transparent z-10"></div>
                        </div>
                    )}
                    
                    <div className={`mt-auto p-4 flex items-center w-full min-w-0 relative z-20`}>
                        <div className="flex flex-col min-w-0">
                            <h1 className="text-white font-black text-base tracking-tight flex items-center drop-shadow-lg">
                                <span className="truncate flex items-center">
                                    {activeServerId === 'home' || !activeServer ? (
                                        <div className="flex items-center group/brand cursor-default mt-1">
                                            <span className="mr-1.5 font-bold text-[18px] tracking-tight text-white">
                                                Mekanda
                                            </span>
                                            <div className="bg-[#5865f2] rounded-full p-0.5 shrink-0 flex items-center justify-center shadow-[0_0_10px_rgba(88,101,242,0.45)]">
                                                <Check size={10} className="text-white stroke-[4]" />
                                            </div>
                                        </div>
                                    ) : (
                                        <span className={`${activeServer?.bannerURL ? 'text-white' : 'bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent'}`}>
                                            {activeServer?.name || 'Yükleniyor...'}
                                        </span>
                                    )}
                                </span>
                                {activeServer && activeServerId !== 'home' && (
                                    <div className="bg-blue-500 rounded-full p-0.5 ml-1.5 shrink-0 flex items-center justify-center shadow-[0_0_10px_rgba(59,130,246,0.4)]">
                                        <Check size={8} className="text-white stroke-[4]" />
                                    </div>
                                )}
                            </h1>
                            {activeServer && activeServer.inviteCode && (
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(activeServer.inviteCode);
                                        showToast('success', 'Davet kodu kopyalandı! 📋');
                                    }}
                                    className="flex items-center space-x-1 group/code cursor-pointer w-fit mt-0.5"
                                    title="Tıklayarak Davet Kodunu Kopyala"
                                >
                                    <span className={`text-[9px] font-black tracking-tighter uppercase transition-colors ${activeServer?.bannerURL ? 'text-slate-300 drop-shadow-md' : 'text-slate-500'} group-hover/code:text-indigo-400 `}>KOD: {activeServer?.inviteCode || '...'}</span>
                                    <Copy size={8} className={`${activeServer?.bannerURL ? 'text-white/60' : 'text-slate-600'} group-hover/code:text-indigo-400 opacity-0 group-hover/code:opacity-100 transition-all`} />
                                </button>
                            )}
                        </div>

                        <div className="ml-auto flex items-center space-x-1">
                            {activeServerId === 'home' ? (
                                <>
                                    <button
                                        onClick={() => { setShowFriends(v => !v); setShowDMs(false); setFriendTab('all'); }}
                                        className={`relative p-1.5 rounded-lg transition-all ${showFriends ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                                        title="Arkadaşlar"
                                    >
                                        <Users size={17} />
                                    </button>
                                    <button
                                        onClick={() => { setShowDMs(v => !v); setShowFriends(false); }}
                                        className={`relative p-1.5 rounded-lg transition-all ${showDMs ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                                        title="Özel Mesajlar"
                                    >
                                        <MessageSquare size={17} />
                                    </button>
                                </>
                            ) : (
                                <>
                                    {(userRole === 'admin' || isCeo) && (
                                        <>
                                            <button
                                                onClick={() => setIsJoinRequestsModalOpen(true)}
                                                className="relative p-1.5 rounded-lg transition-all text-slate-400 hover:text-white hover:bg-white/5"
                                                title="Katılım İstekleri"
                                            >
                                                <UserPlus size={18} />
                                                {joinRequests.length > 0 && (
                                                    <div className="absolute top-0 right-0 w-2.5 h-2.5 bg-rose-500 rounded-full border-2 border-[#0a0a0c] animate-pulse shadow-[0_0_8px_rgba(244,63,94,0.6)]"></div>
                                                )}
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setServerSettingsName(activeServer.name || '');
                                                    setServerSettingsLogo(activeServer.logoURL || '');
                                                    setServerSettingsBanner(activeServer.bannerURL || '');
                                                    setIsServerSettingsModalOpen(true);
                                                }}
                                                className="relative p-1.5 rounded-lg transition-all text-slate-400 hover:text-white hover:bg-white/5"
                                                title="Sunucu Ayarları"
                                            >
                                                <Settings size={18} />
                                            </button>
                                        </>
                                    )}
                                    {activeServerId !== 'home' && (
                                        <button
                                            onClick={handleLeaveServer}
                                            className="relative p-1.5 rounded-lg transition-all text-slate-400 hover:text-rose-400 hover:bg-rose-500/10"
                                            title="Sunucudan Ayrıl"
                                        >
                                            <LogOut size={18} />
                                        </button>
                                    )}
                                    <button className="p-1.5 text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-all md:hidden" onClick={() => setIsSidebarOpen(false)}>
                                        <X size={18} />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </header>


                <div className="flex-1 overflow-y-auto p-3 space-y-6 custom-scrollbar z-10 flex flex-col">
                    {activeServerId === 'home' || !activeServer ? (
                        /* Home/DM navigation list */
                        <div className="space-y-4">
                            <div className="space-y-1">
                                <button
                                    onClick={() => { setShowDiscovery(false); setShowFriends(true); setShowDMs(false); setIsSidebarOpen(false); }}
                                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all ${showFriends ? 'bg-indigo-500/20 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}
                                >
                                    <div className="flex items-center space-x-3">
                                        <Users size={18} />
                                        <span className="font-bold text-sm">Arkadaşlar</span>
                                    </div>
                                    {incomingRequests.length > 0 && (
                                        <span className="bg-red-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full ring-2 ring-[#0a0a0c] animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.4)]">
                                            {incomingRequests.length}
                                        </span>
                                    )}
                                </button>
                                <button
                                    onClick={() => { setShowDiscovery(false); setShowDMs(true); setShowFriends(false); setIsSidebarOpen(false); }}
                                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all ${showDMs ? 'bg-indigo-500/20 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}
                                >
                                    <div className="flex items-center space-x-3">
                                        <MessageSquare size={18} />
                                        <span className="font-bold text-sm">Mesajlar</span>
                                    </div>
                                    {Object.values(dmUnreadCounts).reduce((a, b) => a + b, 0) > 0 && (
                                        <span className="bg-red-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full ring-2 ring-[#0a0a0c] animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.4)]">
                                            {Object.values(dmUnreadCounts).reduce((a, b) => a + b, 0)}
                                        </span>
                                    )}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Metin Kanalları Grubu */}
                            <div>
                                <div className="px-4 mb-3 flex items-center justify-between group/header cursor-default">
                                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] group-hover/header:text-indigo-400 transition-colors">YAZI KANALLARI</span>
                                    {(userRole === 'admin' || isCeo) && (
                                        <div className="flex items-center space-x-1 transition-all">
                                            <button
                                                onClick={() => { setChannelSettingsType('text'); setIsChannelSettingsOpen(true); }}
                                                className="p-1 text-slate-500 hover:text-indigo-400 hover:bg-white/10 rounded transition-all"
                                                title="Yazı Kanalı Ayarları"
                                            >
                                                <Settings size={14} />
                                            </button>
                                            <button
                                                onClick={() => handleCreateChannel('text')}
                                                className="p-1 text-slate-500 hover:text-white hover:bg-white/10 rounded transition-all"
                                                title="Kanal Ekle"
                                            >
                                                <Plus size={14} />
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-[2px]">
                                    {channels.filter(c => c.serverId === activeServerId && (c.type === 'text' || !c.type)).map(channel => {
                                        const total = Number(channel.totalMessages || 0);
                                        const read = Number(userReadStates[channel.id] ?? 0);
                                        const unreadCount = Math.max(0, total - read);
                                        const isActive = activeChannel === channel.id;

                                        return (
                                            <button
                                                key={channel.id}
                                                onClick={() => {
                                                    navigate(`/${activeServerId}/${channel.id}`);
                                                    setIsSidebarOpen(false);
                                                    setShowDiscovery(false);
                                                    setShowFriends(false);
                                                    setShowDMs(false);
                                                }}
                                                className={`group flex items-center justify-between w-full px-2 py-2 rounded-xl transition-all duration-200 ${isActive ? 'bg-indigo-500/15 border border-white/5 shadow-inner' : 'hover:bg-white/5 border border-transparent'}`}
                                            >
                                                <div className="flex items-center space-x-3 overflow-hidden">
                                                    <Hash size={18} className={isActive ? 'text-indigo-400' : 'text-slate-500 group-hover:text-slate-400'} />
                                                    <span className={`text-[14px] font-semibold truncate ${isActive ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'} transition-colors`}>
                                                        {channel.name}
                                                    </span>
                                                </div>
                                                
                                                {/* Unread Badge - Ultra Belirgin Kırmızı */}
                                                {!isActive && unreadCount > 0 && (
                                                    <div className="ml-2 flex items-center shrink-0">
                                                        <div className="bg-[#ff0000] text-white text-[11px] font-black min-w-[22px] h-[22px] px-1.5 flex items-center justify-center rounded-full ring-2 ring-white/10 shadow-[0_0_15px_#ff0000] animate-pulse">
                                                            {unreadCount}
                                                        </div>
                                                    </div>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Ses Kanalları Grubu */}
                            <div>
                                <div className="px-4 mb-3 flex items-center justify-between group/header cursor-default">
                                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] group-hover/header:text-emerald-400 transition-colors">SES ODALARI</span>
                                    {(userRole === 'admin' || isCeo) && (
                                        <div className="flex items-center space-x-1 transition-all">
                                            <button
                                                onClick={() => { setChannelSettingsType('voice'); setIsChannelSettingsOpen(true); }}
                                                className="p-1 text-slate-500 hover:text-emerald-400 hover:bg-white/10 rounded transition-all"
                                                title="Ses Odası Ayarları"
                                            >
                                                <Settings size={14} />
                                            </button>
                                            <button
                                                onClick={() => handleCreateChannel('voice')}
                                                className="p-1 text-slate-500 hover:text-white hover:bg-white/10 rounded transition-all"
                                                title="Kanal Ekle"
                                            >
                                                <Plus size={14} />
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-[2px]">
                                    {voiceChannels.map(channel => {
                                        const usersInThisChannel = voiceUsers.filter(u => u.channelId === channel.id);
                                        const isJoined = joinedVoiceChannel === channel.id;
                                        return (
                                            <div key={channel.id} className="mb-1">
                                                <button
                                                    onClick={() => {
                                                        getAudioContext().resume();
                                                        joinVoiceChannel(channel.id);
                                                    }}
                                                    className={`w-full flex items-center px-4 py-2 rounded-xl text-left transition-all duration-300 group relative ${isJoined
                                                        ? 'bg-emerald-500/10 text-emerald-400'
                                                        : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                                                        }`}
                                                >
                                                    {isJoined && (
                                                        <div className="absolute left-[-12px] top-1/2 -translate-y-1/2 w-1 h-8 bg-[#10b981] rounded-r-full shadow-[0_0_10px_#10b981]"></div>
                                                    )}
                                                    <div className={`p-1.5 rounded-lg mr-3 transition-all duration-300 ${isJoined ? 'bg-emerald-500/20 text-emerald-400 animate-pulse' : 'bg-transparent text-slate-500 group-hover:text-slate-300'}`}>
                                                        <Volume2 size={14} />
                                                    </div>
                                                    <span className={`text-[14px] font-semibold tracking-tight transition-all duration-300 ${isJoined ? 'translate-x-1' : 'group-hover:translate-x-0.5'}`}>
                                                        {channel.name}
                                                    </span>
                                                    {usersInThisChannel.length > 0 && !isJoined && (
                                                        <div className="ml-auto flex -space-x-2">
                                                            {usersInThisChannel.slice(0, 3).map(u => (
                                                                <div key={u.userId} className="w-5 h-5 rounded-md border border-gray-900 bg-gray-800 overflow-hidden ring-1 ring-white/5">
                                                                    {u.profilePic ? (
                                                                        <img src={u.profilePic} className="w-full h-full object-cover" alt="" />
                                                                    ) : (
                                                                        <div className="w-full h-full flex items-center justify-center text-[8px] font-bold text-slate-500">?</div>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </button>

                                                {usersInThisChannel.length > 0 && (
                                                    <div className="mt-1 ml-2 space-y-1 pr-2 animate-slide-in">
                                                        {usersInThisChannel.map(vu => (
                                                            <div key={vu.userId} className={`flex items-center text-slate-300 text-xs py-1.5 px-2 group/user hover:bg-white/5 rounded-lg transition-colors border-l border-white/5 ${!onlineUsers.includes(vu.userId) ? 'opacity-40 grayscale-[0.2] hover:opacity-100 hover:grayscale-0' : ''}`}>
                                                                <div
                                                                    onClick={(e) => setProfileUserModal({ source: "voice", id: vu.userId, name: vu.userName, photoURL: vu.profilePic, role: vu.role, bannerURL: allUsers.find(u => u.id === vu.userId)?.bannerURL })}
                                                                    className={`relative w-5 h-5 rounded-lg bg-indigo-500/20 flex items-center justify-center text-white text-[8px] font-bold mr-2 shrink-0 overflow-hidden ring-1 transition-all cursor-pointer ${speakingUsers.has(vu.userId) ? 'ring-emerald-500 ring-2 shadow-[0_0_10px_#10b981] scale-110 z-10' : 'ring-white/5 group-hover/user:ring-indigo-500/30'}`}
                                                                >
                                                                    {vu.profilePic ? (
                                                                        <img src={vu.profilePic} alt="" className="w-full h-full object-cover" />
                                                                    ) : (
                                                                        vu.userName?.charAt(0).toUpperCase()
                                                                    )}
                                                                    {/* removed online dot */}
                                                                </div>
                                                                <div className="flex-1 flex items-center justify-between min-w-0">
                                                                    <div className="flex items-center min-w-0 flex-1">
                                                                        <span
                                                                            className="truncate font-bold opacity-70 group-hover/user:opacity-100 transition-opacity cursor-pointer"
                                                                            onClick={(e) => setProfileUserModal({ source: "voice", id: vu.userId, name: vu.userName, photoURL: vu.profilePic, role: vu.role, bannerURL: allUsers.find(u => u.id === vu.userId)?.bannerURL })}
                                                                        >
                                                                            {vu.userName}
                                                                        </span>

                                                                        {/* Mute / Deafen İkonları (Senkronize) */}
                                                                        <div className="flex items-center space-x-1 mx-2 text-slate-500 shrink-0">
                                                                            {vu.isMuted && <MicOff size={10} className="text-red-400" />}
                                                                            {vu.isDeafened && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-400"><path d="M10 20l-4-4H3.5A1.5 1.5 0 0 1 2 14.5v-5A1.5 1.5 0 0 1 3.5 8H6l4-4v16z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>}
                                                                        </div>
                                                                    </div>

                                                                    <div className="flex items-center shrink-0">
                                                                        {vu.userId !== user?.uid && (
                                                                            <div className="mr-2 flex items-center space-x-1 opacity-0 group-hover/user:opacity-100 transition-opacity">
                                                                                <Volume2 size={10} className="text-slate-500 shrink-0" />
                                                                                <input
                                                                                    type="range"
                                                                                    min="0" max="1" step="0.05"
                                                                                    value={userVolumes[vu.userId] ?? 1}
                                                                                    onChange={(e) => {
                                                                                        const vol = parseFloat(e.target.value);
                                                                                        setUserVolumes(prev => ({ ...prev, [vu.userId]: vol }));
                                                                                        const audioEl = document.getElementById(`audio-${vu.userId}`);
                                                                                        if (audioEl) audioEl.volume = vol;
                                                                                    }}
                                                                                    className="w-12 h-1 accent-emerald-400 cursor-pointer"
                                                                                    title={`Ses: ${Math.round((userVolumes[vu.userId] ?? 1) * 100)}%`}
                                                                                />
                                                                            </div>
                                                                        )}
                                                                        <StatusBadge role={vu.role} currentUser={vu} />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}
                </div>


                <footer className="mt-auto bg-[#020202] p-1.5 flex items-center justify-between shadow-2xl relative shrink-0">
                    {/* Left: Avatar & Info */}
                    <div
                        className="flex items-center space-x-2 p-1 hover:bg-white/10 rounded-md cursor-pointer transition-colors flex-1 min-w-0 mr-2"
                        onClick={(e) => setProfileUserModal({ clickX: e.clientX, clickY: e.clientY, id: user.uid, name: userName, photoURL: userProfilePic, role: userRole, bannerURL: allUsers?.find(u => u.id === user.uid)?.bannerURL })}
                    >
                        <div className="relative w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-white font-black shrink-0 overflow-hidden shadow-inner">
                            {userProfilePic ? (
                                <img src={userProfilePic} alt={userName} className="w-full h-full object-cover" />
                            ) : (
                                (userName || '?').charAt(0).toUpperCase()
                            )}
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity backdrop-blur-[2px]">
                                <Settings size={12} className="text-white animate-spin-slow" />
                            </div>
                        </div>

                        <div className="flex flex-col overflow-hidden leading-tight flex-1 min-w-0 pr-1">
                            <span className="text-[13px] font-bold text-[#dbdee1] truncate w-full">{userName}</span>
                            <div className="flex items-center space-x-2 h-[14px] w-full min-w-0">
                                <span className="text-[10px] font-black text-[#23a559] tracking-wider opacity-90 shrink-0">Aktif</span>
                                <div className="flex items-center space-x-1 shrink-0 bg-white/5 px-1 rounded-sm border border-white/5">
                                    <div className={`w-1 h-1 rounded-full ${ping < 100 ? 'bg-emerald-500' : ping < 300 ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
                                    <span className="text-[9px] font-black text-slate-400 tracking-tighter uppercase">{appVersion}</span>
                                    <span className="text-slate-600 font-bold mx-0.5 opacity-30">|</span>
                                    <span className="text-[9px] font-black text-slate-500 tracking-tighter">{ping}ms</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right: Controls */}
                    <div className="flex items-center space-x-0.5">
                        <div className="flex rounded-md overflow-hidden">
                            {/* Mic Toggle */}
                            <button
                                onClick={() => setIsMuted(!isMuted)}
                                className={`p-1.5 w-8 h-8 flex items-center justify-center rounded-md transition-colors ${isMuted ? 'text-[#f23f43] hover:bg-white/10' : 'text-[#b5bac1] hover:text-[#dbdee1] hover:bg-white/10'}`}
                                title={isMuted ? "Sesi Aç" : "Sesi Kapat"}
                            >
                                {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                            </button>
                        </div>

                        <div className="flex rounded-md overflow-hidden ml-0.5">
                            {/* Deafen Toggle */}
                            <button
                                onClick={() => setIsDeafened(!isDeafened)}
                                className={`p-1.5 w-8 h-8 flex items-center justify-center rounded-md transition-colors ${isDeafened ? 'text-[#f23f43] hover:bg-white/10' : 'text-[#b5bac1] hover:text-[#dbdee1] hover:bg-white/10'}`}
                                title={isDeafened ? "Sağırlaştırmayı Kapat" : "Sağırlaştır"}
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    {isDeafened ? (
                                        <>
                                            <path d="M10 20l-4-4H3.5A1.5 1.5 0 0 1 2 14.5v-5A1.5 1.5 0 0 1 3.5 8H6l4-4v16z"></path>
                                            <line x1="23" y1="9" x2="17" y2="15"></line>
                                            <line x1="17" y1="9" x2="23" y2="15"></line>
                                        </>
                                    ) : (
                                        <>
                                            <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                                            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                                        </>
                                    )}
                                </svg>
                            </button>
                        </div>

                        <div className="flex ml-0.5">
                            {/* Ses Kapatma (Ayrılma) Butonu */}
                            {joinedVoiceChannel && (
                                <button
                                    onClick={() => leaveVoiceChannel()}
                                    className="p-1.5 w-8 h-8 flex items-center justify-center text-[#b5bac1] hover:bg-[#f23f43]/10 hover:text-[#f23f43] rounded-md transition-colors mr-0.5"
                                    title="Sesten Ayrıl"
                                >
                                    <PhoneOff size={16} />
                                </button>
                            )}

                            {/* Settings */}
                            <button
                                onClick={() => setIsVoiceSettingsOpen(true)}
                                className="p-1.5 w-8 h-8 flex items-center justify-center text-[#b5bac1] hover:bg-white/10 hover:text-[#dbdee1] rounded-md transition-colors"
                                title="Kullanıcı Ayarları"
                            >
                                <Settings size={18} />
                            </button>

                            <button
                                onClick={handleLogout}
                                className="p-1.5 w-8 h-8 flex items-center justify-center text-[#b5bac1] hover:bg-[#f23f43]/10 hover:text-[#f23f43] rounded-md transition-colors"
                                title="Güvenli Çıkış"
                            >
                                <LogOut size={16} />
                            </button>
                        </div>
                    </div>
                </footer>
            </aside>


            <main className="flex-1 flex flex-col min-w-0 z-10">
                {!showFriends && !showDMs && !showDiscovery && (
                    <header className="h-16 flex items-center px-6 border-b border-white/5 backdrop-blur-xl bg-black/10 shrink-0">
                        <button
                            className="mr-4 md:hidden p-2 text-slate-400 hover:bg-white/5 rounded-xl block"
                            onClick={() => setIsSidebarOpen(true)}
                        >
                            <Menu size={22} />
                        </button>
                        <div className="flex items-center space-x-3">
                            <div className="p-2 bg-indigo-500/10 rounded-lg">
                                <Hash size={20} className="text-indigo-400" />
                            </div>
                            <div className="flex flex-col">
                                <h2 className="text-white font-bold text-lg leading-none">
                                    {channels.find(c => c.id === activeChannel)?.name || 'Kanal Seçilmedi'}
                                </h2>
                                <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-widest opacity-80">
                                    Genel Sohbet Ve Tartışma Alanı
                                </p>
                            </div>
                        </div>
                        <div className="ml-auto flex items-center space-x-2">
                            {userRole === 'admin' && (
                                <button
                                    onClick={handleClearChannel}
                                    className="p-2 rounded-xl cursor-pointer transition-all text-red-500/60 hover:text-red-400 hover:bg-red-500/10 group relative"
                                    title="Kanalı Temizle (CEO)"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
                                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                                    </svg>
                                    <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black/80 text-red-300 text-[10px] px-2 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none font-bold">
                                        Kanalı Temizle
                                    </span>
                                </button>
                            )}
                            <button
                                onClick={() => setIsMembersListOpen(!isMembersListOpen)}
                                className={`p-2 rounded-xl cursor-pointer transition-colors ${isMembersListOpen ? 'bg-indigo-400/20 text-indigo-400' : 'text-slate-400 hover:bg-white/5'}`}
                                title="Üye Listesi"
                            >
                                <Users size={20} />
                            </button>
                        </div>

                    </header>
                )} {/* end !showFriends header */}

                {showDiscovery ? (
                    /* =========== DISCOVERY (ÖNERİLENLER) PANELİ =========== */
                    <div className="flex-1 flex flex-col min-h-0 bg-[#020202] mesh-bg overflow-hidden animate-fade-in">
                        <header className="h-16 flex items-center px-8 border-b border-white/5 backdrop-blur-xl bg-black/10 shrink-0">
                            <h2 className="text-white font-black text-lg tracking-tight">Öne Çıkan Sunucular</h2>
                        </header>

                        <div className="flex-1 overflow-hidden p-6 flex flex-col justify-center">
                            {allServers.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full text-center">
                                    <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center mb-4">
                                        <Hash size={24} className="text-indigo-400 opacity-40" />
                                    </div>
                                    <p className="text-slate-500 font-bold">Henüz hiç sunucu oluşturulmamış</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-3 gap-4 max-w-5xl mx-auto w-full">
                                    {allServers.slice(0, 6).map((srv) => (
                                        <div 
                                            key={srv.id} 
                                            onClick={() => {
                                                // Eğer üye değilse katılma mantığı buraya gelebilir, 
                                                // şimdilik sadece sunucuyu seçme (eğer üyeyse) veya detay gösterme
                                                const isMember = myMemberships.includes(srv.id);
                                                if (isMember || isCeo) {
                                                    navigate(`/${srv.id}`);
                                                    setShowDiscovery(false);
                                                } else {
                                                    showToast('info', 'Bu sunucuya henüz üye değilsiniz!');
                                                }
                                            }}
                                            className="group relative bg-[#0a0a0c] border border-white/5 rounded-2xl overflow-hidden hover:border-indigo-500/30 transition-all duration-500 hover:shadow-2xl hover:shadow-indigo-500/10 cursor-pointer"
                                        >
                                            <div className="h-28 overflow-hidden relative">
                                                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0c] to-transparent z-10 opacity-60"></div>
                                                <img 
                                                    src={srv.bannerURL || `https://images.unsplash.com/photo-1614850523296-d8c1af93d400?q=80&w=1470&auto=format&fit=crop`} 
                                                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" 
                                                    alt="" 
                                                />
                                            </div>
                                            <div className="p-4 relative">
                                                <div className="absolute -top-8 left-5 w-14 h-14 rounded-2xl bg-[#0a0a0c] border-4 border-[#0a0a0c] shadow-2xl overflow-hidden z-20 group-hover:scale-105 transition-transform flex items-center justify-center">
                                                    {srv.logoURL ? (
                                                        <img src={srv.logoURL} className="w-full h-full object-cover" alt="" />
                                                    ) : (
                                                        <span className="text-xl font-black text-indigo-400">{(srv.name || '?').charAt(0).toUpperCase()}</span>
                                                    )}
                                                </div>
                                                <div className="mt-6">
                                                    <h3 className="text-white font-black text-base flex items-center group-hover:text-indigo-400 transition-colors">
                                                        <Check size={14} className="text-[#15803d] mr-1.5 fill-[#15803d] p-0.5 rounded-full bg-white/10" />
                                                        {srv.name}
                                                    </h3>
                                                    <p className="text-slate-500 text-xs mt-2 line-clamp-2 leading-relaxed font-medium">
                                                        {srv.description || 'Mekanda topluluğuna hoş geldin! Bu sunucu yeni keşifler ve sohbetler için harika bir yer.'}
                                                    </p>
                                                    <div className="mt-6 flex items-center space-x-4">
                                                        <div className="flex items-center text-[10px] font-black uppercase tracking-wider text-slate-500">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-slate-600 mr-2"></div>
                                                            {srv.memberCount || 1} Üye
                                                        </div>
                                                        <div className="flex items-center text-[10px] font-black uppercase tracking-wider text-slate-500 mt-2 sm:mt-0">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-slate-600 mr-2"></div>
                                                            {allUsers.find(u => u.id === srv.ownerId)?.userName || allUsers.find(u => u.id === srv.ownerId)?.name || 'Topluluk'}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                            {/* Üye durumu rozeti veya Katıl Butonu */}
                                            {myMemberships.includes(srv.id) ? (
                                                <div className="absolute top-3 right-3 z-20 bg-black/80 backdrop-blur-md text-rose-500 text-[10px] font-black px-3 py-1.5 rounded-xl border border-rose-500/20 shadow-xl">
                                                    ÜYESİNİZ
                                                </div>
                                            ) : myPendingRequests[srv.id] ? (
                                                <div className="absolute top-3 right-3 z-20 bg-black/80 backdrop-blur-md text-amber-400 text-[10px] font-black px-3 py-1.5 rounded-xl border border-amber-400/20 shadow-xl">
                                                    İSTEK GÖNDERİLDİ
                                                </div>
                                            ) : (
                                                <button 
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleJoinRequest(srv.id, srv.name);
                                                    }}
                                                    className="absolute top-3 right-3 z-20 bg-black/80 backdrop-blur-md text-emerald-500 hover:text-emerald-400 hover:bg-black text-[10px] font-black px-4 py-2 rounded-xl shadow-xl border border-emerald-500/20 transition-all active:scale-95 flex items-center space-x-1.5"
                                                >
                                                    <Plus size={12} strokeWidth={4} />
                                                    <span>KATIL</span>
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                ) : showDMs ? (
                    /* =========== ÖZEL MESAJLAR PANELI =========== */
                    <div className="flex-1 flex min-h-0 overflow-hidden">
                        {/* Sol: Arkadaş Listesi */}
                        <div className="w-64 border-r border-white/5 flex flex-col flex-shrink-0">
                            <div className="px-4 py-4 border-b border-white/5">
                                <h2 className="text-white font-bold text-sm uppercase tracking-widest opacity-70">Özel Mesajlar</h2>
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar py-2">
                                {myFriends.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-center p-6">
                                        <MessageSquare size={28} className="text-slate-600 mb-2" />
                                        <p className="text-slate-600 text-xs">Arkadaş ekleyerek mesajlaşmaya başla</p>
                                    </div>
                                ) : myFriends.map(friend => {
                                    const friendData = allUsers?.find(u => u.id === friend.friendId);
                                    const isOnline = onlineUsers.includes(friend.friendId);
                                    const convId = getDmConvId(user.uid, friend.friendId);
                                    const unread = dmUnreadCounts[convId] || 0;
                                    const isActive = activeDM?.friendId === friend.friendId;
                                    return (
                                        <button
                                            key={friend.id}
                                            onClick={() => openDMWith(friend)}
                                            className={`w-full flex items-center px-3 py-2.5 rounded-xl mx-1 transition-all text-left ${isActive ? 'bg-indigo-500/10 text-white' : 'hover:bg-white/5 text-slate-300'} ${!isOnline ? 'opacity-40 grayscale-[0.2] hover:opacity-100 hover:grayscale-0' : ''}`}
                                        >
                                            <div className="relative mr-3 shrink-0">
                                                <div className="w-9 h-9 rounded-full bg-indigo-500/20 flex items-center justify-center text-sm font-bold text-indigo-300 overflow-hidden">
                                                    {friendData?.photoURL || friend.friendPhotoURL ? (
                                                        <img src={friendData?.photoURL || friend.friendPhotoURL} className="w-full h-full object-cover" />
                                                    ) : (
                                                        (friendData?.name || friend.friendName || '?').charAt(0).toUpperCase()
                                                    )}
                                                </div>
                                                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0a0a0c] ${isOnline ? 'bg-emerald-500' : 'bg-slate-600'
                                                    }`}></div>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="font-bold text-sm truncate">{friendData?.name || friendData?.userName || friend.friendName}</div>
                                                <div className="text-xs text-slate-500 truncate">{isOnline ? 'Çevrimiçi' : 'Çevrimdışı'}</div>
                                            </div>
                                            {unread > 0 && (
                                                <span className="ml-1 w-5 h-5 bg-red-500 text-white text-[10px] font-black rounded-full flex items-center justify-center shrink-0 animate-pulse shadow-[0_0_6px_#ef4444]">{unread}</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Sağ: Mesaj Alanı */}
                        {activeDM ? (
                            <div className="flex-1 flex flex-col min-h-0">
                                {/* DM Header */}
                                <div className="h-14 flex items-center px-5 border-b border-white/5 shrink-0">
                                    <div className="relative mr-3">
                                        <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-xs font-bold text-indigo-300 overflow-hidden">
                                            {(() => {
                                                const fd = allUsers?.find(u => u.id === activeDM.friendId);
                                                return fd?.photoURL || activeDM.friendPhotoURL
                                                    ? <img src={fd?.photoURL || activeDM.friendPhotoURL} className="w-full h-full object-cover" />
                                                    : (fd?.name || activeDM.friendName || '?').charAt(0).toUpperCase();
                                            })()}
                                        </div>
                                        <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#0a0a0c] ${onlineUsers.includes(activeDM.friendId) ? 'bg-emerald-500' : 'bg-slate-600'
                                            }`}></div>
                                    </div>
                                    <div>
                                        <div className="font-bold text-white text-sm">{allUsers?.find(u => u.id === activeDM.friendId)?.name || allUsers?.find(u => u.id === activeDM.friendId)?.userName || activeDM.friendName}</div>
                                        <div className="text-[10px] text-slate-500">{onlineUsers.includes(activeDM.friendId) ? 'Çevrimiçi' : 'Çevrimdışı'}</div>
                                    </div>
                                </div>
                                {/* Mesajlar */}
                                <div className="flex-1 overflow-y-auto p-5 space-y-3 custom-scrollbar">
                                    {dmMessages.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center h-full text-center">
                                            <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center mb-3">
                                                <MessageSquare size={28} className="text-indigo-400/40" />
                                            </div>
                                            <p className="text-slate-500 text-sm">Henüz mesaj yok. İlk mesajı sen gönder!</p>
                                        </div>
                                    ) : dmMessages.map((msg, i) => {
                                        const isMine = msg.senderId === user.uid;
                                        const prev = dmMessages[i - 1];
                                        const isGrouped = prev && prev.senderId === msg.senderId && (msg.createdAt - prev.createdAt) < 120000;
                                        const t = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
                                        return (
                                            <div key={msg.id} className={`flex items-end space-x-2 ${isMine ? 'flex-row-reverse space-x-reverse' : ''} ${isGrouped ? 'mt-0.5' : 'mt-4'}`}>
                                                {!isGrouped && (
                                                    <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-xs font-bold text-indigo-300 overflow-hidden shrink-0">
                                                        {msg.senderPhotoURL
                                                            ? <img src={msg.senderPhotoURL} className="w-full h-full object-cover" />
                                                            : (msg.senderName || '?').charAt(0).toUpperCase()}
                                                    </div>
                                                )}
                                                {isGrouped && <div className="w-8 shrink-0" />}
                                                <div className={`max-w-[70%] ${isMine ? 'items-end' : 'items-start'} flex flex-col`}>
                                                    {!isGrouped && (
                                                        <span className={`text-[10px] text-slate-500 mb-1 ${isMine ? 'text-right' : ''}`}>{isMine ? 'Sen' : msg.senderName} · {t}</span>
                                                    )}
                                                    <div className={`px-4 py-2.5 rounded-2xl text-sm font-medium leading-relaxed break-words ${isMine
                                                        ? 'bg-indigo-600 text-white rounded-br-sm'
                                                        : 'bg-white/8 text-slate-200 rounded-bl-sm'
                                                        }`}>
                                                        {msg.text}
                                                    </div>
                                                    {msg.imageUrl && (
                                                        <div
                                                            className={`mt-2 max-w-[260px] rounded-xl overflow-hidden border border-white/10 shadow-lg cursor-pointer transition-transform hover:scale-[1.02] active:scale-95 ${isMine ? 'origin-right' : 'origin-left'}`}
                                                            onClick={() => setLightboxImage(msg.imageUrl)}
                                                        >
                                                            <img src={msg.imageUrl} className="w-full h-auto object-cover" alt="DM Shared" />
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                    <div ref={dmMessagesEndRef} />
                                </div>
                                {/* Input */}
                                <form onSubmit={sendDM} className="p-4 shrink-0 border-t border-white/5">
                                    <div className="flex items-center space-x-3">
                                        <input
                                            type="text"
                                            value={dmInput}
                                            onChange={e => setDmInput(e.target.value)}
                                            placeholder={`${allUsers.find(u => u.id === activeDM.friendId)?.name || activeDM.friendName} kişisine mesaj gönder...`}
                                            className="flex-1 glass-card bg-white/5 hover:bg-white/[0.08] text-white rounded-2xl px-5 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 placeholder-slate-500 transition-all font-medium text-sm"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => dmImageInputRef.current && dmImageInputRef.current.click()}
                                            className="p-3 text-slate-400 hover:text-indigo-400 hover:bg-white/5 rounded-xl transition-all"
                                            title="Görsel Gönder"
                                        >
                                            <ImageIcon size={18} />
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={!dmInput.trim()}
                                            className="p-3 bg-indigo-500 hover:bg-indigo-400 disabled:bg-slate-700 disabled:opacity-30 text-white rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-90"
                                        >
                                            <Send size={16} />
                                        </button>
                                    </div>
                                </form>
                            </div>
                        ) : (
                            <div className="flex-1 flex items-center justify-center text-center">
                                <div>
                                    <MessageSquare size={40} className="text-slate-700 mx-auto mb-3" />
                                    <p className="text-slate-500 font-semibold">Bir arkadaş seç ve mesajlaşmaya başla</p>
                                </div>
                            </div>
                        )}
                    </div>
                ) : showFriends ? (
                    /* =========== ARKADAŞLAR PANELI =========== */
                    <div className="flex-1 flex flex-col min-h-0">
                        {/* Sekme Başlıkları */}
                        <div className="flex items-center space-x-1 px-6 pt-4 pb-0 border-b border-white/5">
                            {[
                                { key: 'all', label: 'Tümü', count: myFriends.length },
                                { key: 'pending', label: 'Bekleyen', count: incomingRequests.length }
                            ].map(tab => (
                                <button
                                    key={tab.key}
                                    onClick={() => setFriendTab(tab.key)}
                                    className={`flex items-center space-x-1.5 px-4 py-2.5 text-sm font-bold rounded-t-lg border-b-2 transition-all ${friendTab === tab.key
                                        ? 'text-white border-indigo-500 bg-indigo-500/10'
                                        : 'text-slate-400 border-transparent hover:text-slate-200 hover:bg-white/5'
                                        }`}
                                >
                                    <span>{tab.label}</span>
                                    {tab.count > 0 && (
                                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${tab.key === 'pending'
                                            ? 'bg-red-500 text-white animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.4)]'
                                            : 'bg-indigo-500/20 text-indigo-400'
                                            }`}>{tab.count}</span>
                                    )}
                                </button>
                            ))}
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {friendTab === 'all' ? (
                                /* Tüm Arkadaşlar */
                                myFriends.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-center py-20">
                                        <div className="w-20 h-20 rounded-full bg-indigo-500/10 flex items-center justify-center mb-4">
                                            <Users size={36} className="text-indigo-400/50" />
                                        </div>
                                        <p className="text-slate-400 font-semibold">Henüz arkadaşın yok</p>
                                        <p className="text-slate-600 text-sm mt-1">Diğer kullanıcıların profil kartından arkadaş ekleyebilirsin!</p>
                                    </div>
                                ) : (
                                    <div>
                                        <div className="px-6 py-3 text-[11px] font-black text-slate-500 uppercase tracking-widest">
                                            Çevrimıçi — {myFriends.filter(f => onlineUsers.includes(f.friendId)).length}
                                        </div>
                                        {myFriends
                                            .sort((a, b) => {
                                                const aOnline = onlineUsers.includes(a.friendId);
                                                const bOnline = onlineUsers.includes(b.friendId);
                                                return bOnline - aOnline;
                                            })
                                            .map(friend => {
                                                const friendData = allUsers?.find(u => u.id === friend.friendId);
                                                const isOnline = onlineUsers.includes(friend.friendId);
                                                return (
                                                    <div key={friend.id} className={`flex items-center px-6 py-3 hover:bg-white/5 border-b border-white/5 group cursor-pointer transition-colors ${!isOnline ? 'opacity-40 grayscale-[0.2] hover:opacity-100 hover:grayscale-0' : ''}`}
                                                        onClick={(e) => setProfileUserModal({ source: 'chat', clickX: e.clientX, id: friend.friendId, name: friendData?.name || friendData?.userName || friend.friendName, photoURL: friendData?.photoURL || friend.friendPhotoURL, role: friendData?.role || 'user', bannerURL: friendData?.bannerURL })}
                                                    >
                                                        <div className="relative mr-4 shrink-0">
                                                            <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center text-sm font-bold text-indigo-300 overflow-hidden">
                                                                {friend.friendPhotoURL ? (
                                                                    <img src={friendData?.photoURL || friend.friendPhotoURL} className="w-full h-full object-cover" />
                                                                ) : (
                                                                    (friendData?.name || friend.friendName || '?').charAt(0).toUpperCase()
                                                                )}
                                                            </div>
                                                            <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[#0a0a0c] ${isOnline ? 'bg-emerald-500 shadow-[0_0_6px_#10b981]' : 'bg-slate-600'
                                                                }`}></div>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="font-bold text-white truncate text-sm">{friendData?.name || friendData?.userName || friend.friendName}</div>
                                                            <div className="text-xs text-slate-500">{isOnline ? 'Çevrimıçi' : 'Çevrimdışı'}</div>
                                                        </div>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); openDMWith(friend); }}
                                                            className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-indigo-400 hover:bg-indigo-500/10 rounded-lg transition-all ml-1"
                                                            title="Mesaj Gönder"
                                                        >
                                                            <MessageSquare size={15} />
                                                        </button>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); removeFriend(friend.friendId); }}
                                                            className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all ml-2"
                                                            title="Arkadaşlıktan Çıkar"
                                                        >
                                                            <UserMinus size={16} />
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                    </div>
                                )
                            ) : (
                                /* Bekleyen İstekler */
                                incomingRequests.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-center py-20">
                                        <div className="w-20 h-20 rounded-full bg-slate-800 flex items-center justify-center mb-4">
                                            <UserPlus size={32} className="text-slate-500" />
                                        </div>
                                        <p className="text-slate-400 font-semibold">Bekleyen istek yok</p>
                                    </div>
                                ) : (
                                    <div>
                                        <div className="px-6 py-3 text-[11px] font-black text-slate-500 uppercase tracking-widest">
                                            Gelen İstekler — {incomingRequests.length}
                                        </div>
                                        {incomingRequests.map(req => (
                                            <div key={req.id} className="flex items-center px-6 py-3 hover:bg-white/5 border-b border-white/5 transition-colors">
                                                <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center text-sm font-bold text-indigo-300 overflow-hidden mr-4 shrink-0">
                                                    {req.senderPhotoURL ? (
                                                        <img src={req.senderPhotoURL} className="w-full h-full object-cover" />
                                                    ) : (
                                                        (req.senderName || '?').charAt(0).toUpperCase()
                                                    )}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-bold text-white text-sm">{req.senderName}</div>
                                                    <div className="text-xs text-slate-500">Arkadaşlık isteği gönderdi</div>
                                                </div>
                                                <div className="flex items-center space-x-2 ml-2">
                                                    <button
                                                        onClick={() => acceptFriendRequest(req.id)}
                                                        className="p-2 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 rounded-lg transition-colors"
                                                        title="Kabul Et"
                                                    >
                                                        <Check size={16} />
                                                    </button>
                                                    <button
                                                        onClick={() => rejectFriendRequest(req.id)}
                                                        className="p-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors"
                                                        title="Reddet"
                                                    >
                                                        <X size={16} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar scroll-smooth">
                        {messages.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-center max-w-sm mx-auto animate-slide-in">
                                <div className="w-24 h-24 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 rounded-3xl flex items-center justify-center mb-6 ring-1 ring-white/10 shadow-2xl">
                                    <MessageSquare size={44} className="text-indigo-400 opacity-60" />
                                </div>
                                <h3 className="text-2xl font-bold text-white mb-2">Sohbete Başla!</h3>
                                <p className="text-slate-400 text-sm leading-relaxed">
                                    #{channels.find(c => c.id === activeChannel)?.name || '...'} kanalındasın. Arkadaşlarını davet et ve haydi konuşmaya başlayın!
                                </p>
                            </div>
                        ) : (
                            messages.map((msg, index) => {
                                const prevMsg = messages[index - 1];
                                const isGrouped = prevMsg && prevMsg.userId === msg.userId && (msg.createdAt - prevMsg.createdAt) < 300000;

                                const date = msg.createdAt ? new Date(msg.createdAt) : new Date();
                                const timeString = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

                                // Kullanıcının güncel bilgisini allUsers'dan al (yoksa mesajdaki snapshot halini kullan)
                                const currentUserData = allUsers?.find(u => u.id === msg.userId) || {};
                                const currentName = currentUserData.name || currentUserData.userName || msg.userName || 'Gezgin';
                                const currentPfp = currentUserData.photoURL || msg.profilePic;
                                const currentRole = currentUserData.role || msg.role || 'user';
                                const currentBanner = currentUserData.bannerURL;

                                return (
                                    <div key={msg.id} className={`flex px-2 py-1 rounded-2xl group relative transition-all duration-200 hover:bg-white/5 ${isGrouped ? 'mt-1' : 'mt-6 animate-slide-in'}`}>
                                        {!isGrouped ? (
                                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 ring-2 ring-white/5 flex items-center justify-center text-white font-bold shrink-0 mt-0.5 select-none overflow-hidden shadow-xl transform group-hover:scale-105 transition-transform cursor-pointer" onClick={(e) => setProfileUserModal({ source: "chat", clickX: e.clientX, id: msg.userId, name: currentName, photoURL: currentPfp, role: currentRole, bannerURL: currentBanner })}>
                                                {currentPfp ? (
                                                    <img src={currentPfp} alt={currentName} className="w-full h-full object-cover" />
                                                ) : (
                                                    (currentName || '?').charAt(0).toUpperCase()
                                                )}
                                            </div>
                                        ) : (
                                            <div className="w-12 shrink-0 text-xs text-slate-600 opacity-0 group-hover:opacity-100 text-center leading-[1.5rem] select-none font-medium mt-1">
                                                {timeString}
                                            </div>
                                        )}

                                        <div className="ml-4 flex-1 overflow-hidden">
                                            {!isGrouped && (
                                                <div className="flex items-center space-x-2 mb-1">
                                                    <span
                                                        className="font-bold text-white hover:text-indigo-400 cursor-pointer transition-colors tracking-tight"
                                                        onClick={(e) => setProfileUserModal({ source: "chat", clickX: e.clientX, id: msg.userId, name: currentName, photoURL: currentPfp, role: currentRole, bannerURL: currentBanner })}
                                                    >
                                                        {currentName}
                                                    </span>
                                                    <StatusBadge role={currentRole} />

                                                    {/* Eğer bu kullanıcı şu an bulunduğumuz ses kanalında ise mute/deafen durumunu göster */}
                                                    {voiceUsers.some(vu => vu.userId === msg.userId && vu.channelId === joinedVoiceChannel) && (
                                                        <div className="flex items-center space-x-0.5 ml-1 text-slate-500">
                                                            {msg.userId === user?.uid ? (
                                                                // Kendi mute/deafen durumumuz state'den gelir
                                                                <>
                                                                    {isMuted && <MicOff size={12} className="text-red-400/80" />}
                                                                    {isDeafened && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-400/80"><path d="M10 20l-4-4H3.5A1.5 1.5 0 0 1 2 14.5v-5A1.5 1.5 0 0 1 3.5 8H6l4-4v16z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>}
                                                                </>
                                                            ) : (
                                                                /* Başkalarının mute/deafen durumunu Firestore'dan almak gerekir ancak şu an voiceUsers içinde sadece channelId var.
                                                                   UI olarak eklendi, mantığı eklenebilir. */
                                                                null
                                                            )}
                                                        </div>
                                                    )}

                                                    <span className="text-[10px] text-slate-500 uppercase font-black opacity-50 select-none tracking-widest pl-1">
                                                        {timeString}
                                                    </span>
                                                </div>
                                            )}
                                            <div className={`text-slate-300 leading-relaxed whitespace-pre-wrap break-words text-[15px] ${!isGrouped ? 'font-medium' : ''}`}>
                                                {msg.text}
                                            </div>
                                            {msg.imageUrl && (
                                                <div className="mt-2 max-w-[320px] rounded-xl overflow-hidden border border-white/10 shadow-lg shadow-black/20 group/img relative cursor-pointer" onClick={() => setLightboxImage(msg.imageUrl)}>
                                                    <img src={msg.imageUrl} className="w-full h-auto object-cover transition-transform duration-500 group-hover/img:scale-105" alt="Shared" />
                                                    <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                                                        <div className="p-2 bg-black/40 backdrop-blur-md rounded-full text-white/80">
                                                            <Maximize2 size={18} />
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {/* Mesaj Silme Butonu (Sadece Admin veya Mesaj Sahibi) */}
                                        {(userRole === 'admin' || user?.uid === msg.userId) && (
                                            <div className="absolute right-4 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => handleDeleteMessage(msg.id, msg.userId)} className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors" title="Mesajı Sil">
                                                    <Trash size={14} />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                )} {/* end showFriends ternary */}

                {!showFriends && !showDMs && !showDiscovery && (
                    <div className="p-6 shrink-0 z-20">
                        <form onSubmit={handleSendMessage} className="relative group/form flex items-center space-x-3">
                            <div className="flex-1 relative">
                                <input
                                    type="text"
                                    value={newMessage}
                                    onChange={(e) => setNewMessage(e.target.value)}
                                    placeholder={`#${channels.find(c => c.id === activeChannel)?.name || '...'} kanalına bi' selam ver...`}
                                    className="w-full glass-card bg-white/5 hover:bg-white/[0.08] text-white rounded-2xl pl-12 pr-12 py-4 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 placeholder-slate-500 transition-all duration-300 font-medium"
                                />
                                <div className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center justify-center p-2 bg-indigo-500/10 rounded-lg">
                                    <Hash size={18} className="text-indigo-400" />
                                </div>
                                <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center space-x-1">
                                    <button
                                        type="button"
                                        onClick={() => chatImageInputRef.current && chatImageInputRef.current.click()}
                                        className="p-2 text-slate-400 hover:text-indigo-400 hover:bg-white/5 rounded-xl transition-all"
                                        title="Görsel Yükle"
                                    >
                                        <ImageIcon size={18} />
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={!newMessage.trim()}
                                        className="p-2.5 bg-indigo-500 hover:bg-indigo-400 disabled:bg-slate-700 disabled:opacity-30 disabled:scale-95 text-white rounded-xl transition-all duration-300 shadow-lg shadow-indigo-500/20 active:scale-90"
                                    >
                                        <Send size={18} />
                                    </button>
                                </div>
                            </div>
                        </form>
                        <p className="text-[10px] text-slate-600 mt-2 ml-2 font-bold uppercase tracking-[0.2em] opacity-40">
                            Shift + Enter ile yeni satıra geç
                        </p>
                    </div>
                )}
            </main>


            {/* Arka Planda Sesleri Çalmak İçin */}
            <div className="hidden">
                {/* Kendi sesimiz için (görsel gösterge için) */}
                {localStream && user && (
                    <ParticipantAudio
                        stream={localStream}
                        muted={true}
                        suppressOutput={true}
                        onSpeakingChange={(isSpeaking) => handleSpeakingChange(user.uid, isSpeaking)}
                    />
                )}
                {/* Diğer katılımcıların sesleri */}
                {Object.entries(remoteStreams).map(([uid, stream]) => {
                    // voiceUsers listesinde uid (userId) ile eşleşeni bul
                    const targetUser = voiceUsers?.find(u => u.userId === uid);
                    if (!targetUser) {
                        // fallback: Eğer voiceUsers listesinde yoksa (henüz senkronize değilse) bile sesi renderla
                        return (
                            <ParticipantAudio
                                key={uid}
                                stream={stream}
                                userId={uid}
                                isDeafened={isDeafened}
                                onSpeakingChange={(isSpeaking) => handleSpeakingChange(uid, isSpeaking)}
                            />
                        );
                    }
                    return (
                        <ParticipantAudio
                            key={uid}
                            stream={stream}
                            userId={targetUser.userId}
                            isDeafened={isDeafened}
                            onSpeakingChange={(isSpeaking) => handleSpeakingChange(targetUser.userId, isSpeaking)}
                        />
                    );
                })}
            </div>

            {/* Üye Listesi (Sağ Kenar Çubuğu) */}
            {
                isMembersListOpen && (
                    <aside className="fixed md:static inset-y-0 right-0 z-50 w-64 premium-sidebar border-l border-white/5 flex flex-col transition-all animate-slide-in">
                        <div className="h-16 flex items-center px-6 border-b border-white/5 shrink-0">
                            <span className="font-bold text-slate-400 text-xs uppercase tracking-widest">
                                {activeServerId === 'home' ? 'Arkadaşlar' : 'Üyeler'} — {activeServerId === 'home' ? (allUsers?.filter(u => u.id === user?.uid || myFriends.some(f => f.friendId === u.id)) || []).length : (allUsers?.length || 0)}
                            </span>
                            <button className="ml-auto p-2 text-slate-400 hover:bg-white/5 rounded-lg transition-colors" onClick={() => setIsMembersListOpen(false)}>
                                <X size={18} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
                            {(() => {
                                const displayUsers = activeServerId === 'home'
                                    ? (allUsers?.filter(u => u.id === user?.uid || myFriends.some(f => f.friendId === u.id)) || [])
                                    : (allUsers || []);

                                const onlineUsersList = displayUsers.filter(u => onlineUsers.includes(u.id));
                                const offlineUsersList = displayUsers.filter(u => !onlineUsers.includes(u.id));

                                // Discord stili: Bir kullanıcı en üstteki (hiyerarşide ilk gelen) rolünün altında görünür
                                const displayedUserIds = new Set();

                                const dynamicCategories = [];

                                // 1. Yetkililer (Sabit en üst)
                                const admins = displayUsers.filter(u => u.role === 'admin');
                                if (admins.length > 0) {
                                    dynamicCategories.push({
                                        id: 'yetkililer',
                                        title: 'YETKİLİLER',
                                        color: 'text-red-500',
                                        dotColor: 'bg-red-500',
                                        users: admins
                                    });
                                    admins.forEach(u => displayedUserIds.add(u.id));
                                }

                                // 2. Moderatörler (Sabit ikinci)
                                const moderators = displayUsers.filter(u => u.role === 'moderator' && !displayedUserIds.has(u.id));
                                if (moderators.length > 0) {
                                    dynamicCategories.push({
                                        id: 'moderatorler',
                                        title: 'MODERATÖRLER',
                                        color: 'text-purple-500',
                                        dotColor: 'bg-purple-500',
                                        users: moderators
                                    });
                                    moderators.forEach(u => displayedUserIds.add(u.id));
                                }

                                // 3. Özel Roller (ServerRoles'dan dinamik olarak)
                                serverRoles.forEach(role => {
                                    const roleUsers = displayUsers.filter(u =>
                                        !displayedUserIds.has(u.id) &&
                                        u.customRoles &&
                                        u.customRoles.includes(role.id)
                                    );

                                    if (roleUsers.length > 0) {
                                        // Dinamik renk tespiti
                                        const tailwindColors = {
                                            indigo: 'text-indigo-400',
                                            emerald: 'text-emerald-400',
                                            amber: 'text-amber-400',
                                            rose: 'text-rose-400',
                                            cyan: 'text-cyan-400',
                                            violet: 'text-violet-400'
                                        };
                                        const roleColorClass = tailwindColors[role.color] || 'text-slate-300';
                                        const roleDotClass = (roleColorClass.replace('text-', 'bg-')).replace('-400', '-500');

                                        dynamicCategories.push({
                                            id: role.id,
                                            title: role.name.toUpperCase(),
                                            color: roleColorClass,
                                            dotColor: roleDotClass,
                                            users: roleUsers
                                        });
                                        roleUsers.forEach(u => displayedUserIds.add(u.id));
                                    }
                                });

                                // 4. Diğer Üyeler (Hiç rolü kalmayanlar)
                                const regulars = displayUsers.filter(u => !displayedUserIds.has(u.id));
                                if (regulars.length > 0) {
                                    dynamicCategories.push({
                                        id: 'uyeler',
                                        title: activeServerId === 'home' ? 'ARKADAŞLAR' : 'ÜYELER',
                                        color: 'text-slate-400',
                                        dotColor: 'bg-slate-500',
                                        users: regulars
                                    });
                                }

                                return (
                                    <>
                                        {dynamicCategories.map(cat => (
                                            <div key={cat.id} className="space-y-2">
                                                {activeServerId !== 'home' && (
                                                    <h3 className={`text-[10px] font-black ${cat.color} uppercase tracking-widest px-2 flex items-center`}>
                                                        <div className={`w-1.5 h-1.5 rounded-full ${cat.dotColor} mr-2 shadow-[0_0_5px_currentColor]`}></div>
                                                        {cat.title} — {cat.users.length}
                                                    </h3>
                                                )}
                                                {cat.users.map(u => (
                                                    <div
                                                        key={u.id}
                                                        onClick={(e) => setProfileUserModal({ source: "members", id: u.id, name: u.name || u.userName, photoURL: u.photoURL, role: u.role || 'user', bannerURL: u.bannerURL })}
                                                        className={`flex items-center p-2 rounded-xl transition-all cursor-pointer hover:bg-white/5 group/u ${!onlineUsers.includes(u.id) ? 'opacity-40 grayscale-[0.2] hover:opacity-100 hover:grayscale-0' : ''}`}
                                                    >
                                                        <div className="relative">
                                                            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center text-[10px] font-bold text-indigo-300 group-hover/u:ring-2 ring-indigo-500 transition-all shadow-lg shadow-indigo-500/10">
                                                                {u.photoURL ? <img src={u.photoURL} className="w-full h-full object-cover rounded-lg" /> : (u.name || u.userName || '?').charAt(0).toUpperCase()}
                                                            </div>
                                                                <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 ${onlineUsers.includes(u.id) ? 'bg-emerald-500 shadow-[0_0_4px_#10b981]' : 'bg-slate-500'} border-2 border-[#0a0a0c] rounded-full`}></div>
                                                            </div>
                                                        <div className="ml-3 overflow-hidden flex-1 flex items-center justify-between">
                                                            <div className={`text-sm font-bold truncate ${u.role === 'admin' ? 'text-red-400' : u.role === 'moderator' ? 'text-purple-400' : 'text-slate-300'}`}>
                                                                {u.name || u.userName || 'İsimsiz'}
                                                            </div>
                                                            <StatusBadge role={u.role || 'user'} currentUser={u} />
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ))}
                                    </>
                                );
                            })()}
                        </div>
                    </aside>
                )
            }

            {
                profileUserModal && (
                    <div className="fixed inset-0 z-[200] transition-all animate-fade-in" onClick={(e) => e.target === e.currentTarget && setProfileUserModal(null)}>
                        <div
                            className="absolute flex items-center justify-center"
                            style={(() => {
                                const src = profileUserModal.source;
                                const W = window.innerWidth;
                                let left;
                                if (src === 'members') {
                                    // Snap to just left of the right sidebar (~240px wide)
                                    left = W - 240 - 360 - 24;
                                } else if (src === 'voice') {
                                    // Snap to just right of the left sidebar + channel column (~300px wide)
                                    left = 300;
                                } else {
                                    // chat or unknown: center of screen
                                    left = Math.max(20, Math.min(W - 380, W / 2 - 180));
                                }
                                return { top: '50%', left: Math.max(12, left) + 'px', transform: 'translateY(-50%)' };
                            })()}
                        >
                            <div className="w-[360px] bg-[#0f1115]/95 backdrop-blur-2xl rounded-t-[32px] rounded-b-[32px] overflow-hidden shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] border border-white/5 relative z-10 animate-scale-in group/modal origin-top-left md:origin-center">
                                {/* Banner Section */}
                                <div className="h-32 w-full relative group/banner overflow-hidden">
                                    {profileUserModal.bannerURL ? (
                                        <img src={profileUserModal.bannerURL} className="w-full h-full object-cover transition-transform duration-700 group-hover/banner:scale-110" />
                                    ) : (
                                        <div className={`w-full h-full bg-gradient-to-br ${profileUserModal.role === 'admin' ? 'from-red-600/40 via-red-900/60 to-[#0a0a0c]' : 'from-indigo-600/40 via-purple-900/60 to-[#0a0a0c]'}`}></div>
                                    )}
                                    <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0c] via-transparent to-transparent"></div>

                                    {profileUserModal.id === user.uid && (
                                        <button
                                            onClick={() => handleUpdateProfile('banner')}
                                            className="absolute top-4 left-4 p-2 bg-black/40 hover:bg-white/10 text-white/70 hover:text-white rounded-xl backdrop-blur-md border border-white/10 transition-all active:scale-95 group/btn"
                                            title="Bannerı Değiştir"
                                        >
                                            <ImageIcon size={16} className="group-hover/btn:scale-110 transition-transform" />
                                        </button>
                                    )}

                                    <button
                                        onClick={() => setProfileUserModal(null)}
                                        className="absolute top-4 right-4 p-2 bg-black/40 hover:bg-red-500/20 text-white/70 hover:text-red-400 rounded-xl backdrop-blur-md border border-white/10 transition-all active:scale-95 z-10"
                                    >
                                        <X size={20} />
                                    </button>
                                </div>

                                <div className="flex flex-col relative px-4 pb-4">
                                    {/* Avatar & Status Bubble Row */}
                                    <div className="flex items-end justify-between relative mt-[-60px] pl-2 pr-2">
                                        {/* Left aligned Avatar */}
                                        <div className="relative group/avatar shrink-0 z-20">
                                            <div className="w-[100px] h-[100px] rounded-full bg-[#0a0a0c] p-1.5 shadow-xl relative">
                                                <div className={`w-full h-full rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 ring-1 ring-white/10 flex items-center justify-center text-3xl font-black text-white shadow-inner overflow-hidden cursor-pointer ${!onlineUsers.includes(profileUserModal.id) ? 'opacity-40 grayscale-[0.2]' : ''}`} onClick={(e) => setProfileUserModal({ clickX: e.clientX, clickY: e.clientY, ...profileUserModal, pfpView: true })}>
                                                    {profileUserModal.photoURL ? (
                                                        <img src={profileUserModal.photoURL} alt="" className="w-full h-full object-cover transition-transform duration-500 group-hover/avatar:scale-105" />
                                                    ) : (
                                                        (profileUserModal?.name || '?').charAt(0).toUpperCase()
                                                    )}
                                                </div>
                                                {profileUserModal.id === user.uid && (
                                                    <div onClick={() => handleUpdateProfile('pfp')} className="absolute inset-1.5 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover/avatar:opacity-100 transition-opacity cursor-pointer backdrop-blur-[2px]">
                                                        <Camera size={24} className="text-white bg-black/50 p-1.5 rounded-full" />
                                                    </div>
                                                )}
                                                <div className={`absolute bottom-0 right-0 w-7 h-7 ${onlineUsers.includes(profileUserModal.id) ? 'bg-[#23a559]' : 'bg-[#80848e]'} border-[5px] border-[#0a0a0c] rounded-full shadow-sm`}></div>
                                            </div>
                                        </div>

                                        {/* Status Bubble */}
                                        <div className="bg-[#2b2d31]/80 hover:bg-[#2b2d31] backdrop-blur-md rounded-[16px] rounded-bl-sm py-2 px-3 border border-white/5 shadow-md flex-1 ml-4 mb-2 relative transform transition-colors cursor-pointer group/status">
                                            {/* Small arrow tail for bubble */}
                                            <div className="absolute -left-2 bottom-2 w-4 h-4 bg-[#2b2d31]/80 rotate-45 border-l border-b border-white/5 opacity-80 group-hover/status:opacity-100 transition-opacity"></div>
                                            <div className="flex items-center space-x-2 relative z-10 w-full" onClick={() => { if (profileUserModal.id === user.uid && !editingStatus) { setTempStatus(allUsers.find(u => u.id === profileUserModal.id)?.statusText || ""); setEditingStatus(true); } }}>
                                                <div className="text-slate-400 shrink-0">
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
                                                </div>
                                                {editingStatus && profileUserModal.id === user.uid ? (
                                                    <div className="flex items-center flex-1 space-x-1.5 min-w-0" onClick={e => e.stopPropagation()}>
                                                        <input type="text" maxLength={25} autoFocus value={tempStatus} onChange={e => setTempStatus(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSaveStatus()} placeholder="Notunu yaz..." className="w-full min-w-0 bg-black/40 text-white text-[11px] px-2 py-1 rounded outline-none border border-indigo-500/50 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500 transition-all font-medium" />
                                                        <button onClick={handleSaveStatus} className="text-emerald-400 hover:text-emerald-300 p-1 hover:bg-emerald-400/10 rounded-full transition-colors shrink-0"><Check size={14} /></button>
                                                        <button onClick={() => setEditingStatus(false)} className="text-rose-400 hover:text-rose-300 p-1 hover:bg-rose-400/10 rounded-full transition-colors shrink-0"><X size={14} /></button>
                                                    </div>
                                                ) : (
                                                    <span className={`text-[11px] font-medium opacity-90 truncate flex-1 pr-2 ${allUsers?.find(u => u.id === profileUserModal.id)?.statusText ? 'text-white/90' : 'text-slate-300 italic'}`}>{allUsers?.find(u => u.id === profileUserModal.id)?.statusText?.substring(0, 25) || "Notunu yaz..."}</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Main Body Container (Dark gray box) */}
                                    <div className="bg-[#111214] rounded-[8px] mt-4 p-3 border border-white/5 shadow-inner">
                                        {/* Name and Badges */}
                                        <div className="mb-4 px-1 group/name">
                                            <div className="flex items-center space-x-2">
                                                <h2 className="text-xl font-bold text-white tracking-tight flex items-center">
                                                    {profileUserModal.name}
                                                </h2>
                                                {profileUserModal.id === user.uid && (
                                                    <button onClick={() => handleUpdateProfile('name')} className="p-1 text-slate-500 hover:text-white opacity-0 group-hover/name:opacity-100 transition-opacity">
                                                        <Edit3 size={12} />
                                                    </button>
                                                )}
                                            </div>

                                            <div className="flex items-center space-x-1 mt-0.5">
                                                <span className="text-[13px] font-medium text-[#dbdee1]">
                                                    {(profileUserModal?.name || '').toLowerCase().replace(/\s/g, '')}
                                                </span>
                                                <span className="text-[#dbdee1] mx-1">•</span>
                                                <span className="text-[13px] text-[#dbdee1] font-medium">
                                                    {profileUserModal.name}
                                                </span>
                                                {/* Primary Role as Badge */}
                                                <div className="flex items-center space-x-1 ml-2">
                                                    {profileUserModal.email === 'merttekinler07@gmail.com' && (
                                                        <div className="px-1.5 py-0.5 bg-[#fbbc05]/20 text-[#fbbc05] text-[10px] font-black rounded shadow-[0_0_8px_rgba(251,188,5,0.4)] animate-pulse">👑 FOUNDER & CEO</div>
                                                    )}
                                                    {profileUserModal.role === 'admin' && profileUserModal.email !== 'merttekinler07@gmail.com' && (
                                                        <div className="px-1.5 py-0.5 bg-red-500/20 text-red-500 text-[10px] font-bold rounded shadow-[0_0_8px_rgba(239,68,68,0.2)]">Admin</div>
                                                    )}
                                                    {profileUserModal.role === 'moderator' && (
                                                        <div className="px-1.5 py-0.5 bg-[#ea4335]/20 text-[#ea4335] text-[10px] font-bold rounded shadow-[0_0_8px_rgba(234,67,53,0.2)]">Yetkili</div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Arkadaş Butonu - Sadece başka kullanıcı görüntüleniyorsa göster */}
                                        {profileUserModal.id !== user?.uid && (() => {
                                            const friendObj = myFriends.find(f => f.friendId === profileUserModal.id);
                                            const isFriend = !!friendObj;
                                            const hasSentRequest = outgoingRequests.some(r => r.id === profileUserModal.id);

                                            if (isFriend) return (
                                                <div className="flex space-x-2 mt-2 mb-1">
                                                    <button
                                                        onClick={() => removeFriend(profileUserModal.id)}
                                                        className="flex-1 flex items-center justify-center space-x-2 py-2 px-3 rounded-xl bg-emerald-500/10 text-emerald-400 hover:bg-red-500/10 hover:text-red-400 border border-emerald-500/20 hover:border-red-500/20 text-[13px] font-bold transition-all group"
                                                    >
                                                        <UserCheck size={14} className="group-hover:hidden" /><UserMinus size={14} className="hidden group-hover:block" />
                                                        <span className="group-hover:hidden">Arkadaş</span><span className="hidden group-hover:block">Kaldır</span>
                                                    </button>
                                                    <button
                                                        onClick={() => { openDMWith(friendObj); setProfileUserModal(null); }}
                                                        className="flex-1 flex items-center justify-center space-x-2 py-2 px-3 rounded-xl bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 border border-indigo-500/20 text-[13px] font-bold transition-all"
                                                    >
                                                        <MessageSquare size={14} />
                                                        <span>Mesaj</span>
                                                    </button>
                                                </div>
                                            );
                                            if (hasSentRequest) return (
                                                <button disabled className="w-full mt-2 mb-1 flex items-center justify-center space-x-2 py-2 px-4 rounded-xl bg-slate-500/10 text-slate-500 border border-slate-500/20 text-sm font-bold cursor-not-allowed">
                                                    <Check size={16} /><span>İstek Gönderildi</span>
                                                </button>
                                            );
                                            return (
                                                <button
                                                    onClick={() => sendFriendRequest(profileUserModal.id)}
                                                    className="w-full mt-2 mb-1 flex items-center justify-center space-x-2 py-2 px-4 rounded-xl bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 border border-indigo-500/20 text-sm font-bold transition-all"
                                                >
                                                    <UserPlus size={16} /><span>Arkadaş Ekle</span>
                                                </button>
                                            );
                                        })()}

                                        <div className="space-y-3">
                                            {/* Favori Oyunlarım */}
                                            {(() => {
                                                const fullUser = allUsers.find(u => u.id === profileUserModal.id);
                                                const userFavGamesIds = fullUser?.favoriteGames || [];
                                                const isOwnProfile = profileUserModal.id === user?.uid;

                                                return (
                                                    <div className="relative">
                                                        <div
                                                            className={`bg-[#2b2d31] rounded-[6px] py-2 px-2.5 border border-transparent group/game ${isOwnProfile ? 'cursor-pointer hover:border-white/5 transition-colors' : ''}`}
                                                            onClick={isOwnProfile ? () => setIsEditingGames(!isEditingGames) : undefined}
                                                        >
                                                            <div className="flex items-center justify-between mb-1.5">
                                                                <span className="text-[9px] font-bold text-[#b5bac1] uppercase tracking-wider">Favori Oyunlarım</span>
                                                                {isOwnProfile && <button className="text-[#b5bac1] hover:text-[#dbdee1] opacity-0 group-hover/game:opacity-100 transition-opacity"><Edit3 size={10} /></button>}
                                                            </div>

                                                            {userFavGamesIds.length > 0 ? (
                                                                <div className="grid grid-cols-2 gap-1.5">
                                                                    {userFavGamesIds.slice(0, 4).map(gameId => {
                                                                        const gData = AVAILABLE_GAMES.find(g => g.id === gameId);
                                                                        if (!gData) return null;
                                                                        return (
                                                                            <div key={gameId} className={`flex items-center space-x-1.5 p-1 rounded ${gData.bg} border border-white/5 overflow-hidden`}>
                                                                                <div className="w-5 h-5 rounded-sm bg-black/40 flex items-center justify-center shrink-0 p-0.5 shadow-inner">
                                                                                    <img src={gData.iconUrl} alt={gData.name} className="w-full h-full object-contain filter drop-shadow-md" />
                                                                                </div>
                                                                                <span className="text-[9px] font-bold text-[#dbdee1] truncate">{gData.name}</span>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            ) : (
                                                                <div className="flex items-center space-x-2 opacity-60">
                                                                    <div className="w-6 h-6 rounded-sm border border-dashed border-slate-600 flex items-center justify-center shrink-0">
                                                                        <span className="text-slate-500 font-bold block pb-0.5 text-[10px]">+</span>
                                                                    </div>
                                                                    <p className="text-[10px] text-slate-400 font-medium">Buralar biraz ıssız...</p>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                        </div>

                                        {/* Roles (Atanmış Özel Roller) */}
                                        <div className="mt-4 pt-4 border-t border-[#2b2d31]/50">
                                            <div className="flex flex-wrap gap-1.5">
                                                {(() => {
                                                    const fullUser = allUsers.find(u => u.id === profileUserModal.id);
                                                    const userCustomRoleIds = fullUser?.customRoles || [];
                                                    return userCustomRoleIds.map(roleId => {
                                                        const roleData = serverRoles.find(r => r.id === roleId);
                                                        if (!roleData) return null;
                                                        const roleColor = roleData.color || '#ec4899';
                                                        return (
                                                            <div key={roleId} className="flex items-center px-2 py-0.5 bg-[#1e1f22] backdrop-blur-sm rounded-full border border-white/5 transition-colors cursor-default">
                                                                <div className="w-2.5 h-2.5 rounded-full mr-1.5" style={{ backgroundColor: roleColor, boxShadow: `0 0 4px ${roleColor}` }}></div>
                                                                <span className="text-[11px] font-medium text-[#dbdee1]">{roleData.name}</span>
                                                            </div>
                                                        );
                                                    });
                                                })()}
                                                {(userRole === 'admin' || userRole === 'moderator') && (
                                                    <div
                                                        onClick={() => {
                                                            const fullUser = allUsers.find(u => u.id === profileUserModal.id);
                                                            if (fullUser) setSelectedUserForRole(fullUser);
                                                        }}
                                                        className="flex items-center px-2 py-0.5 bg-[#1e1f22] backdrop-blur-sm rounded-full border border-white/5 transition-colors hover:bg-[#2b2d31] cursor-pointer text-slate-400 hover:text-[#dbdee1]"
                                                        title="Rol Ataması Yap"
                                                    >
                                                        <Plus size={12} />
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {profileUserModal.id !== user.uid && userRole === 'admin' && (
                                        <div className="mt-3 space-y-2">
                                            <div className="flex space-x-2">
                                                {voiceUsers.some(vu => vu.userId === profileUserModal.id) && (
                                                    <button
                                                        onClick={() => handleKickVoice(profileUserModal.id)}
                                                        className="flex-1 py-1.5 bg-[#da373c] hover:bg-[#c92f33] text-white rounded-[4px] font-medium text-[12px] flex items-center justify-center space-x-1 transition-colors opacity-90 hover:opacity-100"
                                                    >
                                                        <VolumeX size={12} />
                                                        <span>Sesten At</span>
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => handleKickServer(profileUserModal.id)}
                                                    className={`flex-1 py-1.5 bg-[#da373c] hover:bg-[#c92f33] text-white rounded-[4px] font-medium text-[12px] flex items-center justify-center space-x-1 transition-colors opacity-90 hover:opacity-100 ${!voiceUsers.some(vu => vu.userId === profileUserModal.id) ? 'basis-full' : ''}`}
                                                >
                                                    <UserMinus size={12} />
                                                    <span>Sunucudan At</span>
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Dışarı Çıkarılmış Oyun Seçme Menüsü */}
                            {isEditingGames && profileUserModal.id === user?.uid && (
                                <>
                                    {/* Görünmez Kapanma Alanı (Click-away Backdrop) */}
                                    <div className="fixed inset-0 z-[140]" onClick={(e) => { e.stopPropagation(); setIsEditingGames(false); }}></div>

                                    <div className="absolute top-1/2 left-full ml-4 -translate-y-1/2 w-[220px] bg-[#1e1f22] border border-white/10 rounded-[12px] p-3 shadow-2xl z-[150] animate-in fade-in slide-in-from-left-4 duration-300" onClick={e => e.stopPropagation()}>
                                        <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/5">
                                            <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Oyun Ekle ({allUsers.find(u => u.id === profileUserModal.id)?.favoriteGames?.length || 0}/4)</span>
                                            <button onClick={(e) => { e.stopPropagation(); setIsEditingGames(false); }} className="text-slate-400 hover:text-white p-1 hover:bg-white/5 rounded transition-colors"><X size={14} /></button>
                                        </div>
                                        <div className="space-y-1 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
                                            {AVAILABLE_GAMES.map(game => {
                                                const userFavGamesIds = allUsers.find(u => u.id === profileUserModal.id)?.favoriteGames || [];
                                                const isSelected = userFavGamesIds.includes(game.id);
                                                return (
                                                    <div
                                                        key={game.id}
                                                        onClick={() => toggleGameSelection(game.id)}
                                                        className={`flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-indigo-500/20 shadow-inner' : 'hover:bg-[#2b2d31]'}`}
                                                    >
                                                        <div className="flex items-center space-x-2.5 min-w-0">
                                                            <div className={`w-6 h-6 rounded bg-black/40 flex items-center justify-center shrink-0 p-0.5 shadow-inner`}>
                                                                <img src={game.iconUrl} alt={game.name} className="w-full h-full object-contain filter drop-shadow-sm" />
                                                            </div>
                                                            <span className={`text-[11px] font-bold truncate ${isSelected ? 'text-white' : 'text-slate-300'}`}>{game.name}</span>
                                                        </div>
                                                        {isSelected ? (
                                                            <div className="w-4 h-4 rounded-full bg-indigo-500 flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(99,102,241,0.6)]">
                                                                <Check size={10} className="text-white" />
                                                            </div>
                                                        ) : (
                                                            <div className="w-4 h-4 rounded-full border border-slate-600 shrink-0"></div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )
            }

            {/* Rol Yönetimi Modalı */}
            {
                selectedUserForRole && (
                    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
                        <div className="absolute inset-0 bg-black/80 backdrop-blur-md animate-fade-in" onClick={() => setSelectedUserForRole(null)}></div>
                        <div className="bg-[#0a0a0c] border border-white/5 rounded-[24px] w-72 max-w-[90vw] shadow-2xl overflow-hidden relative z-10 animate-scale-in origin-center ring-1 ring-white/10 flex flex-col max-h-[90vh]">
                            {/* Header */}
                            <div className="h-32 bg-gradient-to-br from-indigo-900/40 via-purple-900/20 to-[#0a0a0c] relative p-6 flex flex-col justify-end shrink-0">
                                <div className="absolute top-4 right-4">
                                    <button onClick={() => setSelectedUserForRole(null)} className="p-2 bg-black/40 hover:bg-white/10 text-slate-300 rounded-full backdrop-blur-md transition-colors border border-white/10 hover:text-white">
                                        <X size={18} />
                                    </button>
                                </div>
                                <div>
                                    <h2 className="text-xl font-black text-white tracking-tight uppercase">Rol Yönetimi</h2>
                                    <p className="text-indigo-300/80 text-sm font-medium">@{selectedUserForRole.name} adlı kullanıcının rolleri</p>
                                </div>
                            </div>

                            <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
                                {/* Temel Yetki Rolü - Kullanıcı Kendisi Değilse Göster */}
                                {selectedUserForRole.id !== user?.uid && (
                                    <>
                                        <div>
                                            <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">SİSTEM YETKİSİ</h3>
                                            <div className="grid grid-cols-2 gap-3">
                                                <button
                                                    onClick={() => handleUpdateUserRole(selectedUserForRole.id, 'user')}
                                                    className={`p-3 rounded-xl border flex flex-col items-center justify-center space-y-2 transition-all ${selectedUserForRole.currentRole === 'user' ? 'bg-indigo-500/20 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.2)]' : 'bg-white/5 border-white/5 hover:bg-white/10 text-slate-400'}`}
                                                >
                                                    <div className={`w-3 h-3 rounded-full ${selectedUserForRole.currentRole === 'user' ? 'bg-indigo-400 shadow-[0_0_8px_#818cf8]' : 'bg-slate-500'}`}></div>
                                                    <span className={`text-xs font-bold uppercase ${selectedUserForRole.currentRole === 'user' ? 'text-indigo-300' : ''}`}>Üye</span>
                                                </button>
                                                <button
                                                    onClick={() => handleUpdateUserRole(selectedUserForRole.id, 'moderator')}
                                                    className={`p-3 rounded-xl border flex flex-col items-center justify-center space-y-2 transition-all ${selectedUserForRole.currentRole === 'moderator' ? 'bg-purple-500/20 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.2)]' : 'bg-white/5 border-white/5 hover:bg-white/10 text-slate-400'}`}
                                                >
                                                    <div className={`w-3 h-3 rounded-full ${selectedUserForRole.currentRole === 'moderator' ? 'bg-purple-400 shadow-[0_0_8px_#c084fc]' : 'bg-slate-500'}`}></div>
                                                    <span className={`text-xs font-bold uppercase ${selectedUserForRole.currentRole === 'moderator' ? 'text-purple-300' : ''}`}>Yetkili</span>
                                                </button>
                                            </div>
                                        </div>

                                        <hr className="border-white/5" />
                                    </>
                                )}

                                {/* Özel Roller Atama */}
                                <div>
                                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">ÖZEL ROLLER</h3>
                                    <div className="space-y-2">
                                        {serverRoles.length === 0 ? (
                                            <div className="text-sm text-slate-500 italic text-center py-4 bg-white/5 rounded-xl border border-white/5">
                                                Henüz oluşturulmuş özel bir rol yok.
                                            </div>
                                        ) : (
                                            serverRoles.map(role => {
                                                const hasRole = (selectedUserForRole.customRoles || []).includes(role.id);
                                                const colorHex = role.color || '#6366f1';
                                                return (
                                                    <div key={role.id} className="flex flex-col mb-2">
                                                        <div className="flex items-center justify-between p-3 bg-white/5 border border-white/5 rounded-xl hover:bg-white/10 transition-colors">
                                                            <div className="flex flex-1 items-center space-x-3">
                                                                <div className={`w-3 h-3 rounded-full shadow-lg`} style={{ backgroundColor: colorHex, boxShadow: `0 0 10px ${colorHex}80` }}></div>
                                                                <span className="text-sm font-bold text-slate-200">{role.name}</span>
                                                            </div>
                                                            <div className="flex items-center space-x-3">
                                                                <button onClick={() => handleDeleteRole(role.id)} className="p-1 text-slate-500 hover:bg-red-500/20 hover:text-red-400 rounded-lg transition-colors">
                                                                    <X size={14} />
                                                                </button>
                                                                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                                                                    <input type="checkbox" className="sr-only peer" checked={hasRole} onChange={() => handleToggleCustomRole(selectedUserForRole.id, role.id)} />
                                                                    <div className="w-9 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                                                                </label>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>

                                <hr className="border-white/5" />

                                {/* Yeni Rol Oluşturma Formu */}
                                <form onSubmit={handleCreateRole} className="bg-indigo-500/5 p-4 rounded-2xl border border-indigo-500/20">
                                    <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-3 flex items-center">
                                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 mr-2 shadow-[0_0_5px_#6366f1]"></span>
                                        Yeni Rol Oluştur
                                    </h3>
                                    <div className="space-y-3">
                                        <input
                                            type="text"
                                            value={newRoleName}
                                            onChange={(e) => setNewRoleName(e.target.value)}
                                            placeholder="Rol Adı (Örn: VIP, Server Booster)"
                                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500/50 placeholder-slate-500 transition-colors"
                                        />
                                        <div className="flex items-center space-x-2">
                                            <input
                                                type="color"
                                                value={newRoleColor.startsWith('#') ? newRoleColor : '#6366f1'}
                                                onChange={(e) => setNewRoleColor(e.target.value)}
                                                className="w-10 h-10 p-1 bg-white/5 border border-white/10 rounded-xl cursor-pointer"
                                                title="Rol Rengi Seç"
                                            />
                                            <button
                                                type="submit"
                                                disabled={!newRoleName.trim()}
                                                className="flex-1 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:bg-slate-700 text-white text-sm font-bold py-2.5 px-4 rounded-xl transition-colors flex items-center justify-center"
                                            >
                                                Oluştur
                                            </button>
                                        </div>
                                    </div>
                                </form>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Ses Ayarları Modalı */}
            {
                isVoiceSettingsOpen && (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center animate-fade-in p-4">
                        <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setIsVoiceSettingsOpen(false)}></div>
                        <div className="bg-[#0a0a0c] border border-white/5 rounded-[32px] w-full max-w-md shadow-2xl overflow-hidden relative z-10 animate-slide-up ring-1 ring-white/10 flex flex-col max-h-[85vh] transition-all duration-300">
                            {/* Header */}
                            <div className="h-32 bg-gradient-to-br from-indigo-900/40 via-purple-900/20 to-[#0a0a0c] relative p-8 flex items-center justify-between shrink-0">
                                <div className="absolute inset-0 bg-[length:20px_20px] bg-center [background-image:radial-gradient(ellipse_at_center,rgba(255,255,255,0.05)_1px,transparent_1px)] opacity-50"></div>

                                <div className="relative flex items-center space-x-4">
                                    <div className="p-3 bg-indigo-500/20 text-indigo-400 rounded-2xl ring-1 ring-indigo-500/30 shadow-[0_0_20px_rgba(99,102,241,0.2)]">
                                        <Settings size={24} />
                                    </div>
                                    <div>
                                        <h2 className="text-xl font-black text-white tracking-tight uppercase">Ses Ayarları</h2>
                                        <p className="text-indigo-300/80 text-[10px] font-bold uppercase tracking-widest">
                                            Donanım Kontrolü
                                        </p>
                                    </div>
                                </div>

                                <button
                                    onClick={() => setIsVoiceSettingsOpen(false)}
                                    className="relative p-2 bg-black/40 hover:bg-white/10 text-slate-300 rounded-full backdrop-blur-md transition-colors border border-white/10 hover:text-white"
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            {/* Content */}
                            <div className="p-8 overflow-y-auto custom-scrollbar flex-1 space-y-6">
                                {/* Bas-Konuş Ayarı */}
                                <div className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-2xl hover:bg-white/10 transition-colors">
                                    <div>
                                        <div className="text-white font-bold mb-1">Bas-Konuş (PTT)</div>
                                        <div className="text-slate-400 text-xs leading-relaxed">Sadece <kbd className="bg-black/50 border border-white/10 px-1.5 py-0.5 rounded text-indigo-300 mx-1">Boşluk</kbd> tuşuna basılı tutarken sesin iletilir.</div>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-4">
                                        <input type="checkbox" className="sr-only peer" checked={isPTTMode} onChange={(e) => setIsPTTMode(e.target.checked)} />
                                        <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                                    </label>
                                </div>

                                {/* Gürültü Engelleyici Ayarı */}
                                <div className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-2xl hover:bg-white/10 transition-colors">
                                    <div>
                                        <div className="text-white font-bold mb-1">Arkaplan Gürültü Engelleyici</div>
                                        <div className="text-slate-400 text-xs leading-relaxed">Klavye, fan ve çevre seslerini filtreleyerek net bir iletişim sağlar.</div>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-4">
                                        <input type="checkbox" className="sr-only peer" checked={noiseSuppress} onChange={(e) => {
                                            setNoiseSuppress(e.target.checked);
                                            noiseSuppressRef.current = e.target.checked;
                                            if (window._diskort_refreshAudio) window._diskort_refreshAudio();
                                        }} />
                                        <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                                    </label>
                                </div>

                                {/* Yankı Engelleyici Ayarı */}
                                <div className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-2xl hover:bg-white/10 transition-colors">
                                    <div>
                                        <div className="text-white font-bold mb-1">Yankı Giderici</div>
                                        <div className="text-slate-400 text-xs leading-relaxed">Hoparlörden gelen sesin tekrar mikrofona sekmesini engeller.</div>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-4">
                                        <input type="checkbox" className="sr-only peer" checked={echoCancellation} onChange={(e) => {
                                            setEchoCancellation(e.target.checked);
                                            if (joinedVoiceChannel) showToast('info', 'Değişikliğin etkili olması için odadan çıkıp tekrar girmeniz gerekebilir.');
                                        }} />
                                        <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                                    </label>
                                </div>

                                {/* Oturumu Kapat Butonu */}
                                <button
                                    onClick={() => {
                                        setIsVoiceSettingsOpen(false);
                                        handleLogout();
                                    }}
                                    className="w-full mt-4 flex items-center justify-center space-x-3 p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-2xl hover:bg-red-500/20 transition-all duration-300 group"
                                >
                                    <LogOut size={20} className="group-hover:-translate-x-1 transition-transform" />
                                    <span className="font-black uppercase tracking-widest text-sm">Oturumu Kapat</span>
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Kanal Ayarları Modalı (Sadece Admin) */}
            {
                isChannelSettingsOpen && (userRole === 'admin' || isCeo) && (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center animate-fade-in p-4">
                        <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setIsChannelSettingsOpen(false)}></div>
                        <div className="bg-[#0a0a0c] border border-white/5 rounded-[32px] w-full max-w-[400px] shadow-2xl overflow-hidden relative z-10 animate-slide-up ring-1 ring-white/10 flex flex-col max-h-[85vh] transition-all duration-300">

                            {/* Header */}
                            <div className={`h-24 bg-gradient-to-br ${channelSettingsType === 'text' ? 'from-indigo-900/40 via-purple-900/20' : 'from-emerald-900/40 via-teal-900/20'} to-[#0a0a0c] relative p-6 flex items-center justify-between shrink-0`}>
                                <div className="absolute inset-0 bg-[length:20px_20px] bg-center [background-image:radial-gradient(ellipse_at_center,rgba(255,255,255,0.05)_1px,transparent_1px)] opacity-50"></div>

                                <div className="relative flex items-center space-x-3">
                                    <div className={`p-2.5 rounded-xl ring-1 shadow-lg ${channelSettingsType === 'text' ? 'bg-indigo-500/20 text-indigo-400 ring-indigo-500/30 shadow-indigo-500/20' : 'bg-emerald-500/20 text-emerald-400 ring-emerald-500/30 shadow-emerald-500/20'}`}>
                                        {channelSettingsType === 'text' ? <Hash size={20} /> : <Volume2 size={20} />}
                                    </div>
                                    <div>
                                        <h2 className="text-base font-black text-white tracking-tight uppercase">{channelSettingsType === 'text' ? 'Yazı Kanalları' : 'Ses Odaları'}</h2>
                                        <p className={`text-[9px] font-bold uppercase tracking-widest ${channelSettingsType === 'text' ? 'text-indigo-300/80' : 'text-emerald-300/80'}`}>
                                            {channelSettingsType === 'text' ? 'Metin Yönetimi' : 'Ses Yönetimi'}
                                        </p>
                                    </div>
                                </div>

                                <button
                                    onClick={() => setIsChannelSettingsOpen(false)}
                                    className="relative p-1.5 bg-black/40 hover:bg-white/10 text-slate-300 rounded-full backdrop-blur-md transition-colors border border-white/10 hover:text-white"
                                >
                                    <X size={16} />
                                </button>
                            </div>

                            {/* Content */}
                            <div className="p-6 overflow-y-auto custom-scrollbar flex-1 space-y-4">
                                <button 
                                    onClick={() => handleCreateChannel(channelSettingsType)}
                                    className={`w-full flex items-center justify-center space-x-2 py-3 rounded-2xl border border-dashed transition-all active:scale-95 font-black text-[10px] uppercase tracking-[0.15em] ${channelSettingsType === 'text' ? 'bg-indigo-500/5 border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/10' : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10'}`}
                                >
                                    <Plus size={16} />
                                    <span>{channelSettingsType === 'text' ? 'YENİ YAZI KANALI EKLE' : 'YENİ SES ODASI EKLE'}</span>
                                </button>

                                <div className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center pl-1 border-b border-white/5 pb-2">
                                    {channelSettingsType === 'text' ? <Hash size={10} className="mr-2 text-indigo-400" /> : <Volume2 size={10} className="mr-2 text-emerald-400" />}
                                    {channelSettingsType === 'text' ? 'Yazı Kanallarını Yönet' : 'Ses Odalarını Yönet'}
                                </div>
                                <div className="space-y-1.5 flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                                    {(channelSettingsType === 'text' ? channels : voiceChannels).length === 0 ? (
                                        <div className="p-5 bg-white/[0.02] border border-white/5 rounded-2xl text-center text-[10px] text-slate-500 italic">
                                            Bu kategoride henüz kanal yok.
                                        </div>
                                    ) : (
                                        (channelSettingsType === 'text' ? channels : voiceChannels).map(ch => (
                                            <div key={ch.id} className="flex items-center justify-between p-2 bg-white/5 border border-white/5 rounded-2xl hover:bg-white/10 transition-all group/item">
                                                <div className="flex items-center space-x-2 min-w-0">
                                                    <div className={`p-1.5 rounded-lg shrink-0 ${channelSettingsType === 'text' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                                                        {channelSettingsType === 'text' ? <Hash size={10} /> : <Volume2 size={10} />}
                                                    </div>
                                                    <span className="text-xs font-bold text-slate-200 truncate group-hover/item:text-white transition-colors">
                                                        {ch.name}
                                                    </span>
                                                </div>
                                                <div className="flex items-center space-x-0.5 shrink-0">
                                                    <button
                                                        onClick={() => handleUpdateChannel(ch.id, channelSettingsType, ch.name)}
                                                        className={`p-1.5 text-slate-500 rounded-lg transition-all ${channelSettingsType === 'text' ? 'hover:text-indigo-400 hover:bg-indigo-500/10' : 'hover:text-emerald-400 hover:bg-emerald-500/10'}`}
                                                        title="Düzenle"
                                                    >
                                                        <Edit3 size={12} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteChannel(ch.id, channelSettingsType, ch.name)}
                                                        className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                                                        title="Sil"
                                                    >
                                                        <Trash size={12} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Sunucu Ayarları Modalı */}
            {isServerSettingsModalOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in custom-scrollbar overflow-y-auto">
                    <div className="bg-[#111] rounded-3xl w-full max-w-[400px] shadow-2xl shadow-indigo-500/10 border border-white/10 overflow-hidden transform transition-all p-5 my-auto">
                        <div className="flex justify-between items-center mb-5">
                            <h2 className="text-base font-black text-white px-1">Sunucu Ayarları</h2>
                            <button onClick={() => setIsServerSettingsModalOpen(false)} className="text-slate-400 hover:text-white p-1.5 rounded-xl hover:bg-white/5 transition-all">
                                <X size={18} />
                            </button>
                        </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1.5">
                                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-[0.15em] px-1">Sunucu Adı</label>
                                    <input
                                        type="text"
                                        maxLength={10}
                                        value={serverSettingsName}
                                        onChange={(e) => setServerSettingsName(e.target.value)}
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3.5 py-2 text-white text-sm focus:outline-none focus:border-indigo-500/40 transition-all font-bold placeholder-slate-600"
                                        placeholder="Sunucu Adı"
                                        required
                                    />
                                </div>
                                
                                <div className="space-y-1.5">
                                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-[0.15em] px-1">Hızlı İşlemler</label>
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteServer()}
                                        className="w-full flex items-center justify-center space-x-2 px-3.5 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 rounded-xl transition-all font-black text-[10px] border border-rose-500/10 active:scale-95 group"
                                    >
                                        <Trash size={12} className="group-hover:rotate-12 transition-transform" />
                                        <span>SUNUCUYU KOMPLE SİL</span>
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3 mt-4">
                                {/* Logo Upload */}
                                <div className="space-y-1.5">
                                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-[0.15em] px-1">Logo</label>
                                    <div 
                                        onClick={() => serverSettingsLogoInputRef.current?.click()}
                                        className="h-24 rounded-2xl bg-white/5 border border-white/10 flex flex-col items-center justify-center cursor-pointer hover:bg-white/[0.08] hover:border-indigo-500/20 transition-all group relative overflow-hidden"
                                    >
                                        {(serverSettingsLogoFile || serverSettingsLogo) ? (
                                            <img src={serverSettingsLogoFile || serverSettingsLogo} alt="Logo" className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="text-slate-500 flex flex-col items-center space-y-1">
                                                <ImagePlus size={18} />
                                                <span className="text-[8px] font-black">YÜKLE</span>
                                            </div>
                                        )}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[9px] font-black text-white px-2 text-center">DEĞİŞTİR</div>
                                    </div>
                                    <input ref={serverSettingsLogoInputRef} type="file" accept="image/*,.gif" className="hidden" onChange={(e) => handleFileUpload(e, 'serverSettingsLogo')} />
                                </div>

                                {/* Banner Upload */}
                                <div className="space-y-1.5">
                                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-[0.15em] px-1">Banner</label>
                                    <div 
                                        onClick={() => serverSettingsBannerInputRef.current?.click()}
                                        className="h-24 rounded-2xl bg-white/5 border border-white/10 flex flex-col items-center justify-center cursor-pointer hover:bg-white/[0.08] hover:border-purple-500/20 transition-all group relative overflow-hidden"
                                    >
                                        {(serverSettingsBannerFile || serverSettingsBanner) ? (
                                            <img src={serverSettingsBannerFile || serverSettingsBanner} alt="Banner" className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="text-slate-500 flex flex-col items-center space-y-1">
                                                <ImageIcon size={18} />
                                                <span className="text-[8px] font-black">YÜKLE</span>
                                            </div>
                                        )}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[9px] font-black text-white px-2 text-center">DEĞİŞTİR</div>
                                    </div>
                                    <input ref={serverSettingsBannerInputRef} type="file" accept="image/*,.gif" className="hidden" onChange={(e) => handleFileUpload(e, 'serverSettingsBanner')} />
                                </div>
                            </div>

                            <div className="flex space-x-2 pt-4 border-t border-white/5 mt-3">
                                <button type="button" onClick={() => setIsServerSettingsModalOpen(false)} className="flex-1 px-4 py-2.5 bg-white/5 hover:bg-white/10 text-slate-400 rounded-xl transition-all font-bold text-[11px]">
                                    İptal
                                </button>
                                <button type="button" onClick={() => handleUpdateServer()} className="flex-[2] px-4 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl transition-all font-black text-[11px] shadow-lg shadow-indigo-500/10 active:scale-95">
                                    DEĞİŞİKLİKLERİ KAYDET
                                </button>
                            </div>
                        </div>
                    </div>
                )}

            {/* Katılım İstekleri Modalı */}
            {isJoinRequestsModalOpen && (
                <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in custom-scrollbar overflow-y-auto">
                    <div className="bg-[#111] rounded-3xl w-full max-w-md shadow-2xl shadow-rose-500/10 border border-white/10 overflow-hidden transform transition-all p-6 my-auto">
                        <div className="flex justify-between items-center mb-6">
                            <div className="flex flex-col px-2">
                                <h2 className="text-xl font-black text-white">Katılım İstekleri</h2>
                                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-0.5">{activeServer?.name} sunucusu için</p>
                            </div>
                            <button onClick={() => setIsJoinRequestsModalOpen(false)} className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-white/5 transition-all">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                            {joinRequests.length === 0 ? (
                                <div className="py-12 flex flex-col items-center justify-center text-center space-y-3 opacity-50">
                                    <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center">
                                        <Users size={20} className="text-slate-400" />
                                    </div>
                                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Henüz bekleyen istek yok</p>
                                </div>
                            ) : (
                                joinRequests.map((req) => (
                                    <div key={req.id} className="group p-4 bg-white/5 border border-white/5 rounded-2xl hover:bg-white/[0.07] transition-all flex items-center justify-between">
                                        <div className="flex items-center space-x-3 min-w-0">
                                            <div className="w-10 h-10 rounded-xl overflow-hidden bg-white/5 shrink-0 shadow-inner">
                                                {req.profilePic ? (
                                                    <img src={req.profilePic} className="w-full h-full object-cover" alt="" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center text-indigo-400 font-black bg-indigo-500/10 uppercase tracking-tighter">
                                                        {(req.userName || '?').charAt(0)}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-col min-w-0">
                                                <span className="text-sm font-black text-white truncate">{req.userName}</span>
                                                <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                                                    {new Date(req.createdAt).toLocaleDateString('tr-TR')}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="flex items-center space-x-2">
                                            <button 
                                                onClick={(e) => { e.stopPropagation(); handleDeclineJoinRequest(req.id, req); }}
                                                className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all"
                                                title="Reddet"
                                            >
                                                <X size={18} />
                                            </button>
                                            <button 
                                                onClick={(e) => { e.stopPropagation(); handleApproveJoinRequest(req.id, req); }}
                                                className="p-2 bg-emerald-500 text-white rounded-xl shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 transition-all active:scale-95"
                                                title="Onayla"
                                            >
                                                <Check size={18} strokeWidth={3} />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="mt-6 pt-4 border-t border-white/5">
                            <button 
                                onClick={() => setIsJoinRequestsModalOpen(false)}
                                className="w-full py-3 bg-white/5 hover:bg-white/10 text-slate-300 rounded-2xl transition-all font-bold text-xs uppercase tracking-widest border border-white/5"
                            >
                                Kapat
                            </button>
                        </div>
                    </div>
                </div>
            )}


            {/* Sunucu Oluşturma Modalı */}
            {isCreateServerModalOpen && (
                <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={() => { setIsCreateServerModalOpen(false); setServerModalView('selection'); }}>
                    <div className="w-[440px] glass-card bg-[#0f1115]/95 border border-white/5 rounded-[32px] p-8 shadow-2xl animate-in zoom-in-95 duration-500" onClick={(e) => e.stopPropagation()}>

                        {serverModalView === 'selection' && (
                            <div className="animate-in fade-in zoom-in-95 duration-300">
                                <div className="text-center mb-10">
                                    <h2 className="text-3xl font-black text-white mb-2 tracking-tight">Mekanını Seç</h2>
                                    <p className="text-slate-400 text-sm">Yeni bir kanal oluştur veya bir davetle katıl.</p>
                                </div>
                                <div className="grid grid-cols-1 gap-4">
                                    <button
                                        onClick={() => setServerModalView('create')}
                                        className="group p-6 rounded-[24px] bg-indigo-500/10 border border-indigo-500/20 hover:bg-indigo-500/20 hover:border-indigo-500/40 transition-all text-left flex items-center justify-between"
                                    >
                                        <div className="flex items-center space-x-4">
                                            <div className="w-12 h-12 rounded-2xl bg-indigo-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20 group-hover:scale-110 transition-transform">
                                                <Plus size={24} />
                                            </div>
                                            <div>
                                                <div className="text-lg font-black text-white">Sunucu Oluştur</div>
                                                <div className="text-xs text-slate-400">Kendi mekanını yarat ve yönet.</div>
                                            </div>
                                        </div>
                                        <Hash size={20} className="text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </button>

                                    <button
                                        onClick={() => setServerModalView('join')}
                                        className="group p-6 rounded-[24px] bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-all text-left flex items-center justify-between"
                                    >
                                        <div className="flex items-center space-x-4">
                                            <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20 group-hover:scale-110 transition-transform">
                                                <UserPlus size={24} />
                                            </div>
                                            <div>
                                                <div className="text-lg font-black text-white">Sunucuya Katıl</div>
                                                <div className="text-xs text-slate-400">Bir davet koduyla mekana gir.</div>
                                            </div>
                                        </div>
                                        <Check size={20} className="text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </button>
                                </div>
                                <div className="mt-8 text-center">
                                    <button onClick={() => setIsCreateServerModalOpen(false)} className="text-sm font-bold text-slate-500 hover:text-white transition-colors">Kapat</button>
                                </div>
                            </div>
                        )}

                        {serverModalView === 'create' && (
                            <div className="animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center mb-8">
                                    <h2 className="text-2xl font-black text-white mb-2">Sunucunu Oluştur</h2>
                                    <p className="text-slate-400 text-sm">Sunucuna bir isim ve ikon vererek kişiselleştir.</p>
                                </div>

                                <div className="flex flex-col items-center mb-8">
                                    <div
                                        onClick={() => serverLogoInputRef.current?.click()}
                                        className="w-24 h-24 rounded-[32px] bg-indigo-500/10 border-2 border-dashed border-indigo-500/30 flex flex-col items-center justify-center cursor-pointer hover:bg-indigo-500/20 transition-all group relative overflow-hidden"
                                    >
                                        {newServerLogo ? (
                                            <img src={newServerLogo} className="w-full h-full object-cover" />
                                        ) : (
                                            <>
                                                <Camera size={24} className="text-indigo-400 mb-1 group-hover:scale-110 transition-transform" />
                                                <span className="text-[10px] font-black text-indigo-300">LOGO EKLE</span>
                                            </>
                                        )}
                                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                            <ImageIcon size={20} className="text-white" />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <div>
                                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2 px-1">SUNUCU İSMİ</label>
                                        <input
                                            type="text"
                                            value={newServerName}
                                            onChange={(e) => setNewServerName(e.target.value)}
                                            placeholder="Örn: Mert'in Mekanı"
                                            className="w-full bg-white/5 hover:bg-white/[0.08] text-white rounded-2xl px-5 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-all font-bold placeholder-slate-600"
                                        />
                                    </div>
                                </div>

                                <div className="mt-8 flex items-center justify-between">
                                    <button
                                        onClick={() => setServerModalView('selection')}
                                        className="px-6 py-3 text-sm font-bold text-slate-400 hover:text-white transition-colors"
                                    >
                                        Geri Dön
                                    </button>
                                    <button
                                        onClick={() => handleCreateServer()}
                                        disabled={!newServerName.trim() || uploadLoading}
                                        className="px-8 py-3 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-30 text-white rounded-2xl font-bold transition-all shadow-lg shadow-indigo-500/20 active:scale-95 flex items-center space-x-2"
                                    >
                                        {uploadLoading ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/20 border-t-white"></div> : <span>Oluştur</span>}
                                    </button>
                                </div>
                            </div>
                        )}

                        {serverModalView === 'join' && (
                            <div className="animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center mb-8">
                                    <h2 className="text-2xl font-black text-white mb-2">Sunucuya Katıl</h2>
                                    <p className="text-slate-400 text-sm">Sana gönderilen davet kodunu aşağıya gir.</p>
                                </div>

                                <div className="space-y-4">
                                    <div>
                                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2 px-1">DAVET KODU</label>
                                        <input
                                            type="text"
                                            value={inviteInput}
                                            onChange={(e) => setInviteInput(e.target.value.toUpperCase())}
                                            placeholder="Örn: X1Y2Z3W"
                                            className="w-full bg-white/5 hover:bg-white/[0.08] text-white rounded-2xl px-5 py-3.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-all font-bold placeholder-slate-600 tracking-widest text-center"
                                        />
                                    </div>
                                    <p className="text-[10px] text-slate-500 px-1 font-medium italic">Davet linkleri genelde rastgele harf ve rakamlardan oluşur.</p>
                                </div>

                                <div className="mt-8 flex items-center justify-between">
                                    <button
                                        onClick={() => setServerModalView('selection')}
                                        className="px-6 py-3 text-sm font-bold text-slate-400 hover:text-white transition-colors"
                                    >
                                        Geri Dön
                                    </button>
                                    <button
                                        onClick={() => handleJoinServer()}
                                        disabled={!inviteInput.trim() || uploadLoading}
                                        className="px-8 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 text-white rounded-2xl font-bold transition-all shadow-lg shadow-emerald-500/20 active:scale-95 flex items-center space-x-2"
                                    >
                                        {uploadLoading ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/20 border-t-white"></div> : <span>Katıl</span>}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Premium Lightbox Modal */}
            {lightboxImage && (
                <div
                    className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/90 backdrop-blur-lg animate-in fade-in duration-300"
                    onClick={() => setLightboxImage(null)}
                >
                    <div className="absolute top-6 right-6 flex items-center space-x-4">
                        <button className="p-3 bg-white/5 hover:bg-white/10 text-white/70 hover:text-white rounded-2xl backdrop-blur-md border border-white/10 transition-all active:scale-95"><X size={24} /></button>
                    </div>
                    <div className="relative max-w-[95vw] max-h-[90vh] flex items-center justify-center group/light">
                        <img
                            src={lightboxImage}
                            className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl animate-in zoom-in-95 duration-500 border border-white/5"
                            alt="Full View"
                            onClick={(e) => e.stopPropagation()}
                        />
                        <div className="absolute -bottom-12 left-1/2 -translate-x-1/2 text-white/50 text-xs font-medium tracking-widest uppercase opacity-0 group-hover/light:opacity-100 transition-opacity duration-300">Resim dışına tıklayarak kapatabilirsin</div>
                    </div>
                </div>
            )}

            {/* Gizli Dosya Inputları */}
            <input
                type="file"
                ref={pfpInputRef}
                className="hidden"
                accept="image/*"
                onChange={(e) => handleFileUpload(e, 'pfp')}
            />
            <input
                type="file"
                ref={bannerInputRef}
                className="hidden"
                accept="image/*"
                onChange={(e) => handleFileUpload(e, 'banner')}
            />
            <input
                type="file"
                ref={chatImageInputRef}
                className="hidden"
                accept="image/*"
                onChange={(e) => handleFileUpload(e, 'chat')}
            />
            <input
                type="file"
                ref={dmImageInputRef}
                className="hidden"
                accept="image/*"
                onChange={(e) => handleFileUpload(e, 'dm')}
            />
            <input
                type="file"
                ref={serverLogoInputRef}
                className="hidden"
                accept="image/*"
                onChange={(e) => handleFileUpload(e, 'serverLogo')}
            />

            {/* Yükleme Overlay */}
            {
                uploadLoading && (
                    <div className="fixed inset-0 z-[999] bg-black/60 backdrop-blur-sm flex items-center justify-center">
                        <div className="glass-card bg-[#0a0a0c]/90 border border-indigo-500/30 rounded-3xl p-8 flex flex-col items-center space-y-4 shadow-2xl shadow-indigo-500/20">
                            <div className="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
                            <p className="text-white font-bold text-sm">Yükleniyor...</p>
                            <p className="text-slate-500 text-xs">Lütfen bekleyin</p>
                        </div>
                    </div>
                )
            }

            {/* Toast Bildirimi */}
            {
                uploadToast && (
                    <div className={`fixed bottom-8 right-8 z-[1000] flex items-center space-x-3 px-5 py-4 rounded-2xl shadow-2xl border animate-slide-in transition-all ${uploadToast.type === 'success' ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-emerald-500/20' :
                        uploadToast.type === 'error' ? 'bg-red-500/20 border-red-500/40 text-red-300 shadow-red-500/20' :
                            'bg-indigo-500/20 border-indigo-500/40 text-indigo-300 shadow-indigo-500/20'
                        }`}>
                        <span className="text-xl">
                            {uploadToast.type === 'success' ? '✨' : uploadToast.type === 'error' ? '❌' : '⏳'}
                        </span>
                        <span className="font-bold text-sm">{uploadToast.message}</span>
                    </div>
                )
            }
            </div>
        </div>
    );
}

export default function App() {
    return (
        <ErrorBoundary>
            <UpdateNotification />
            <MainApp />
        </ErrorBoundary>
    );
}

