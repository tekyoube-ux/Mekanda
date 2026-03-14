import React, { useState } from 'react';
import { Hash, Mail, Lock, User as UserIcon, LogIn, UserPlus, Image as ImageIcon } from 'lucide-react';
import { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { auth, googleProvider, db, APP_ID } from './firebase';
import { doc, setDoc } from 'firebase/firestore';

export default function Auth() {
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [pfpUrl, setPfpUrl] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleGoogleAuth = async () => {
        try {
            setError('');
            setLoading(true);
            const result = await signInWithPopup(auth, googleProvider);
            const user = result.user;

            // Firebase Firestore'a kullanıcı kaydı oluştur
            const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
            await setDoc(userDocRef, {
                id: user.uid,
                name: user.displayName || 'Anonim',
                photoURL: user.photoURL || '',
                email: user.email,
                lastLogin: Date.now()
            }, { merge: true });

            // Google'dan gelen ismi localStorage'a kaydet (App.jsx oradan okuyacak)
            if (user.displayName) localStorage.setItem('miniDiscordName', user.displayName);
            if (user.photoURL) localStorage.setItem('miniDiscordPfp', user.photoURL);
        } catch (err) {
            console.error("Google Login Error:", err);
            setError("Google ile giriş yapılamadı. Tarayıcı penceresi engellenmiş olabilir veya iptal ettiniz.");
        } finally {
            setLoading(false);
        }
    };

    const handleEmailAuth = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            if (isLogin) {
                await signInWithEmailAndPassword(auth, email, password);
            } else {
                if (!name.trim()) throw new Error("Lütfen bir kullanıcı adı girin.");
                if (password.length < 6) throw new Error("Şifre en az 6 karakter olmalıdır.");

                const result = await createUserWithEmailAndPassword(auth, email, password);
                const user = result.user;

                await updateProfile(user, {
                    displayName: name,
                    photoURL: pfpUrl.trim() || ''
                });

                // Firestore'a kaydet
                const userDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'users', user.uid);
                await setDoc(userDocRef, {
                    id: user.uid,
                    name: name,
                    photoURL: pfpUrl.trim() || '',
                    email: email,
                    createdAt: Date.now(),
                    lastLogin: Date.now()
                }, { merge: true });

                localStorage.setItem('miniDiscordName', name);
                if (pfpUrl.trim()) localStorage.setItem('miniDiscordPfp', pfpUrl.trim());
            }
        } catch (err) {
            console.error("Email Auth Error:", err);
            if (err.code === 'auth/email-already-in-use') setError("Bu e-posta adresi zaten kullanımda.");
            else if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') setError("E-posta veya şifre hatalı.");
            else setError(err.message || "Bir hata oluştu.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex h-screen w-full items-center justify-center bg-gray-950 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/30 via-gray-900 to-black text-white relative overflow-hidden">
            {/* Arka Plan Efektleri (Glassmorphism blobs) */}
            <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-indigo-600/30 rounded-full blur-[120px] pointer-events-none"></div>
            <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-purple-600/20 rounded-full blur-[120px] pointer-events-none"></div>

            <div className="z-10 relative flex items-center justify-center w-full min-h-[600px]">
                {/* LOGIN CARD */}
                <div className="w-full max-w-md p-8 bg-gray-900/40 backdrop-blur-2xl border border-gray-700/50 rounded-3xl shadow-[0_8px_32px_0_rgba(0,0,0,0.5)] relative z-20">

                    <div className="flex flex-col items-center mb-8 pt-4">
                        <div className="relative w-28 h-28 mb-6 animate-float z-10 group cursor-default">
                            <div className="absolute inset-2 bg-purple-600/40 rounded-3xl blur-2xl animate-pulse-slow"></div>
                            <img src="./logo.png" alt="Mekanda Logo" className="w-full h-full object-contain relative z-10 drop-shadow-[0_0_15px_rgba(168,85,247,0.3)] transition-transform group-hover:scale-105 duration-500" />
                        </div>

                        <h1 className="text-4xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-br from-white via-indigo-100 to-purple-400 drop-shadow-[0_4px_12px_rgba(168,85,247,0.4)] mb-2 relative z-10">
                            Mekanda
                        </h1>
                        <p className="text-[#848b98] text-xs font-black tracking-widest uppercase">Yeni Nesil Dijital Mekan</p>
                    </div>

                    {error && (
                        <div className="mb-6 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm text-center font-medium animate-pulse">
                            {error}
                        </div>
                    )}

                    <button
                        onClick={handleGoogleAuth}
                        disabled={loading}
                        className="w-full flex items-center justify-center px-4 py-3.5 mb-6 bg-white hover:bg-gray-100 text-gray-900 rounded-xl font-bold transition-all disabled:opacity-50 transform hover:-translate-y-0.5 active:translate-y-0 shadow-lg shadow-white/10"
                    >
                        <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                        </svg>
                        Google ile Devam Et
                    </button>

                    <div className="flex items-center mb-6">
                        <div className="flex-1 h-px bg-white/5"></div>
                        <span className="px-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest">veya e-posta</span>
                        <div className="flex-1 h-px bg-white/5"></div>
                    </div>

                    <form onSubmit={handleEmailAuth} className="space-y-4">
                        {!isLogin && (
                            <div className="relative group">
                                <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-indigo-400 transition-colors" size={18} />
                                <input
                                    type="text"
                                    placeholder="Kullanıcı Adı"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="w-full bg-[#0d1017]/80 border border-white/5 text-white rounded-xl pl-12 pr-4 py-3.5 focus:outline-none focus:ring-1 focus:ring-purple-500/50 focus:border-purple-500/50 transition-all placeholder-[#4b5563]"
                                    required={!isLogin}
                                />
                            </div>
                        )}
                        <div className="relative group">
                            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-indigo-400 transition-colors" size={18} />
                            <input
                                type="email"
                                placeholder="E-posta Adresi"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-gray-900/50 border border-gray-700/60 text-white rounded-xl pl-12 pr-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all placeholder-gray-500"
                                required
                            />
                        </div>
                        <div className="relative group">
                            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-indigo-400 transition-colors" size={18} />
                            <input
                                type="password"
                                placeholder="Şifre"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-gray-900/50 border border-gray-700/60 text-white rounded-xl pl-12 pr-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all placeholder-gray-500"
                                required
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full flex items-center justify-center py-3.5 bg-gradient-to-r from-[#6366f1] to-[#a855f7] hover:from-[#4f46e5] hover:to-[#9333ea] text-white rounded-xl font-bold transition-all disabled:opacity-50 transform hover:-translate-y-0.5 active:translate-y-0 shadow-[0_0_20px_rgba(168,85,247,0.3)] mt-6"
                        >
                            {isLogin ? <><LogIn size={18} className="mr-2" /> Giriş Yap</> : <><UserPlus size={18} className="mr-2" /> Ücretsiz Kayıt Ol</>}
                        </button>
                    </form>

                    <div className="mt-8 text-center text-sm text-gray-400">
                        {isLogin ? "Mekanda'ya yeni misin?" : "Zaten bir hesabın var mı?"}
                        <button
                            onClick={() => { setIsLogin(!isLogin); setError(''); }}
                            className="ml-2 text-indigo-400 hover:text-indigo-300 font-bold transition-colors"
                            type="button"
                        >
                            {isLogin ? "Kayıt Ol" : "Giriş Yap"}
                        </button>
                    </div>
                </div>

                {/* PREMIUM HORIZONTAL DOWNLOAD BUTTON */}
                <div className="hidden lg:flex absolute left-1/2 ml-[280px] top-1/2 -translate-y-1/2 z-10 flex-col items-center gap-4 transition-all duration-700 animate-fade-in-up">
                    <div className="max-w-[280px] text-center">
                        <p className="text-[#94a3b8] text-[13px] font-medium leading-relaxed opacity-80 italic">
                            "Uygulamamız geliştirme aşamasındadır. Sizlerin değerli yorumları ve geri bildirimleri bizler için çok önemlidir."
                        </p>
                    </div>
                    <a
                        href="https://www.dropbox.com/scl/fi/fmfy0ib6zob95hpke8ltf/Mekanda-Setup.exe?rlkey=37lwl4f8dyfhzt98emf2btkia&e=1&st=b4qg626a&dl=1"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="premium-download-horizontal group"
                    >
                        <div className="download-icon-circle">
                            <svg
                                className="w-6 h-6 download-arrow-premium"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                            </svg>
                        </div>
                        <div className="download-text-group">
                            <span className="download-text-main">Mekanda'yı İndir</span>
                            <span className="download-text-sub">En Yeni Sürüm • Windows Setup</span>
                        </div>
                        <div className="absolute right-[-10px] top-1/2 -translate-y-1/2 w-1.5 h-10 bg-indigo-500 rounded-full opacity-0 group-hover:opacity-100 blur-[2px] transition-opacity"></div>
                    </a>
                </div>
            </div>
        </div>
    );
}
