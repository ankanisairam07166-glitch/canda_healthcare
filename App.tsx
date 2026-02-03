
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppStatus, TranscriptionEntry } from './types';
import { decode, decodeAudioData, encode } from './utils/audio';

const HOSPITAL_NAME = "Canada Care Hospital";

const SYSTEM_INSTRUCTION = `
You are a professional, polite, and calm hospital receptionist for ${HOSPITAL_NAME} in Canada.

====================
SPEECH STYLE (MANDATORY)
====================
- Speak strictly in Canadian English (en-CA).
- Sound like a professional hospital receptionist in Canada.
- Use neutral North American pronunciation with distinct Canadian intonation.
- Tone: Polite, warm, and helpful.
- Use Canadian phrasing: "How can I help you today?", "Pardon me?", "One moment, please", "Thank you kindly", "Sorry about that".

====================
PACE & STABILITY (CRITICAL)
====================
- HUMAN PACE: Respond naturally and promptly. 
- TURN-TAKING: Wait for approximately 1.0 to 1.5 seconds of silence before responding. Do not wait for 5+ seconds.
- BE CONCISE: Keep your turns short (1-2 sentences) to maintain a natural "back-and-forth" flow. 
- Do not let the conversation drag; if the patient is silent, offer help or ask if they are still there after a natural pause.

====================
PRIVACY & BOOKING
====================
- Sequence: Name -> Department (General, Cardiology, Orthopedics, Pediatrics) -> Date -> Time -> Phone number.
- Summarize and confirm all details clearly before finishing the call.
- Never ask for credit card numbers or insurance details.
- Never give medical advice.
`;

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasAudioData, setHasAudioData] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const isClosingRef = useRef(false);
  
  // Audio Recording Refs
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mixerRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Persistent nodes
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const micToMixerNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  const transcriptionBufferRef = useRef({ user: '', agent: '' });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions]);

  const handleStop = useCallback((errorOccurred: boolean = false) => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;

    setStatus(errorOccurred ? AppStatus.ERROR : AppStatus.IDLE);

    if (sessionPromiseRef.current) {
      const p = sessionPromiseRef.current;
      sessionPromiseRef.current = null;
      p.then(session => {
        try { session.close(); } catch(e) {}
      }).catch(() => {});
    }

    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch(e) {}
    }

    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    if (micToMixerNodeRef.current) {
      micToMixerNodeRef.current.disconnect();
      micToMixerNodeRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    
    setIsProcessing(false);
    
    setTimeout(() => {
      isClosingRef.current = false;
    }, 500);
  }, []);

  const handleStart = async () => {
    if (isClosingRef.current) return;
    
    try {
      setErrorMessage(null);
      setHasAudioData(false);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
      recordedChunksRef.current = [];
      
      setStatus(AppStatus.CONNECTING);
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }

      await audioContextRef.current.resume();
      await outputAudioContextRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mixer = outputAudioContextRef.current.createMediaStreamDestination();
      mixerRef.current = mixer;

      const micSource = outputAudioContextRef.current.createMediaStreamSource(stream);
      micToMixerNodeRef.current = micSource;
      micSource.connect(mixer);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { 
              prebuiltVoiceConfig: { 
                voiceName: 'Zephyr'
              } 
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setStatus(AppStatus.CONNECTED);
            setErrorMessage(null);
            
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
              ? 'audio/webm;codecs=opus' 
              : 'audio/webm';

            const recorder = new MediaRecorder(mixer.stream, { mimeType });
            recorder.ondataavailable = (e) => {
              if (e.data.size > 0) recordedChunksRef.current.push(e.data);
            };
            recorder.onstop = () => {
              const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
              audioUrlRef.current = URL.createObjectURL(blob);
              setHasAudioData(true);
            };
            recorder.start(1000); 
            recorderRef.current = recorder;
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioPart = message.serverContent?.modelTurn?.parts?.find(p => p.inlineData?.data);
            const base64Audio = audioPart?.inlineData?.data;
            
            if (base64Audio && outputAudioContextRef.current) {
              setIsProcessing(false);
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const buffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              
              source.connect(ctx.destination);
              if (mixerRef.current) {
                source.connect(mixerRef.current);
              }
              
              source.onended = () => activeSourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsProcessing(false);
            }

            if (message.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.user += message.serverContent.inputTranscription.text;
              setIsProcessing(true);
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionBufferRef.current.agent += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const userText = transcriptionBufferRef.current.user.trim();
              const agentText = transcriptionBufferRef.current.agent.trim();
              if (userText) setTranscriptions(prev => [...prev, { type: 'user', text: userText, timestamp: new Date() }]);
              if (agentText) setTranscriptions(prev => [...prev, { type: 'agent', text: agentText, timestamp: new Date() }]);
              transcriptionBufferRef.current = { user: '', agent: '' };
              setIsProcessing(false);
            }
          },
          onerror: (e: any) => {
            console.error("Session Error Observed:", e);
            if (isClosingRef.current) return;
            setErrorMessage("Line unstable. Resetting connection...");
            handleStop(true);
          },
          onclose: (e: any) => {
            if (isClosingRef.current) return;
            handleStop();
          }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;

      const source = audioContextRef.current!.createMediaStreamSource(stream);
      const processor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
      sourceNodeRef.current = source;
      processorNodeRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMuted || isClosingRef.current || !sessionPromiseRef.current) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        const l = inputData.length;
        const int16 = new Int16Array(l);
        for (let i = 0; i < l; i++) {
          int16[i] = inputData[i] * 32768;
        }
        const pcmBlob = {
          data: encode(new Uint8Array(int16.buffer)),
          mimeType: 'audio/pcm;rate=16000',
        };
        
        sessionPromiseRef.current?.then((session) => {
          if (!isClosingRef.current && session) {
            session.sendRealtimeInput({ media: pcmBlob });
          }
        }).catch(() => {});
      };

      source.connect(processor);
      processor.connect(audioContextRef.current!.destination);

    } catch (err) {
      console.error("Critical Startup Error:", err);
      setErrorMessage("System error. Check mic permissions.");
      setStatus(AppStatus.IDLE);
    }
  };

  const downloadTranscript = useCallback(() => {
    if (transcriptions.length === 0) return;
    const log = transcriptions
      .map(t => `[${t.timestamp.toLocaleTimeString()}] ${t.type === 'user' ? 'Patient' : 'Receptionist'}: ${t.text}`)
      .join('\n\n');
    const blob = new Blob([log], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `canada-care-transcript-${new Date().getTime()}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [transcriptions]);

  const downloadAudio = useCallback(() => {
    if (!audioUrlRef.current) return;
    const link = document.createElement('a');
    link.href = audioUrlRef.current;
    link.download = `canada-care-call-${new Date().getTime()}.webm`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 md:p-8 bg-slate-100 selection:bg-indigo-100">
      <div className="w-full max-w-5xl h-[85vh] grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        <aside className="lg:col-span-1 flex flex-col gap-4 h-full">
          <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-200 flex flex-col">
            <div className="flex items-center gap-3 mb-8">
              <div className="bg-indigo-600 p-2.5 rounded-2xl text-white shadow-lg shadow-indigo-100">
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0V6H8a1 1 0 010-2h1V3a1 1 0 011-1z" /><path d="M4 8a1 1 0 011-1h10a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1V8zm2 2v2h2v-2H6zm5 0v2h2v-2h-2zm-5 4v2h2v-2H6zm5 0v2h2v-2h-2z" /></svg>
              </div>
              <div>
                <h1 className="text-lg font-black text-slate-800 tracking-tight">Canada Care</h1>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">AI Receptionist</p>
              </div>
            </div>

            <div className="space-y-3">
              <button 
                onClick={downloadTranscript}
                disabled={transcriptions.length === 0}
                className="w-full py-3 bg-indigo-50 text-indigo-700 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-100 disabled:opacity-30 transition-all flex items-center justify-center gap-2 border border-indigo-100"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Download Log
              </button>

              <button 
                onClick={downloadAudio}
                disabled={!hasAudioData}
                className="w-full py-3 bg-emerald-50 text-emerald-700 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-100 disabled:opacity-30 transition-all flex items-center justify-center gap-2 border border-emerald-100"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                Call Recording
              </button>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-100">
              <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Units</h3>
              <div className="grid grid-cols-2 gap-2">
                {['General', 'Cardio', 'Ortho', 'Peds'].map(d => (
                  <span key={d} className="px-3 py-1.5 bg-slate-50 text-slate-500 rounded-xl border border-slate-200 text-[10px] font-bold text-center">{d}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-indigo-600 rounded-3xl p-6 shadow-xl text-white flex-1 flex flex-col justify-between overflow-hidden relative mt-auto">
            <div className="z-10">
              <h3 className="text-sm font-black tracking-tight mb-2 uppercase text-white">en-CA Profile</h3>
              <p className="text-[11px] text-indigo-100 leading-relaxed font-medium">Professional Canadian Receptionist profile is active. Human-like conversational pace enabled.</p>
            </div>
            <div className="bg-white/10 px-4 py-3 rounded-2xl border border-white/5 z-10 backdrop-blur-sm">
              <span className="text-[9px] font-black uppercase block opacity-60 mb-1 tracking-tighter">Live Status</span>
              <div className="flex items-center gap-2.5">
                <div className={`w-2 h-2 rounded-full animate-pulse ${status === AppStatus.CONNECTED ? 'bg-green-400' : 'bg-slate-300'}`} />
                <span className="text-[10px] font-black uppercase tracking-widest">{status}</span>
              </div>
            </div>
            <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-white/5 rounded-full blur-3xl" />
          </div>
        </aside>

        <main className="lg:col-span-3 bg-white rounded-3xl shadow-xl border border-slate-200 flex flex-col overflow-hidden relative">
          
          <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between bg-white/80 backdrop-blur-md sticky top-0 z-20">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${status === AppStatus.CONNECTED ? 'bg-green-500 animate-pulse' : status === AppStatus.CONNECTING ? 'bg-amber-400 animate-bounce' : 'bg-slate-300'}`} />
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.25em]">
                {status === AppStatus.CONNECTED ? 'Secure Line Active' : 'System Standby'}
              </span>
            </div>
            {isProcessing && (
              <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full uppercase animate-pulse border border-indigo-100">
                AI Processing...
              </span>
            )}
            {errorMessage && (
              <div className="bg-rose-50 px-4 py-1.5 rounded-full border border-rose-100 flex items-center gap-2 shadow-sm animate-in fade-in slide-in-from-top-1">
                <div className="w-1.5 h-1.5 bg-rose-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-black text-rose-600 uppercase tracking-tighter">
                  {errorMessage}
                </span>
              </div>
            )}
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 space-y-6 bg-slate-50/10">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-sm mx-auto opacity-40">
                <div className="w-24 h-24 bg-slate-100 rounded-3xl flex items-center justify-center mb-8 shadow-inner rotate-3">
                  <svg className="w-12 h-12 text-slate-400 -rotate-3" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" /></svg>
                </div>
                <h4 className="text-base font-black text-slate-800 mb-2 uppercase tracking-tight">Canada Care Hospital</h4>
                <p className="text-[11px] font-bold text-slate-500 leading-relaxed uppercase tracking-widest">Natural voice interaction terminal. Tap the phone icon below to start a booking.</p>
              </div>
            ) : (
              transcriptions.map((t, i) => (
                <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-3 duration-500`}>
                  <div className={`max-w-[80%] px-6 py-4 rounded-3xl shadow-sm border ${
                    t.type === 'user' 
                      ? 'bg-indigo-600 text-white border-indigo-500 rounded-tr-none' 
                      : 'bg-white text-slate-700 border-slate-200 rounded-tl-none'
                  }`}>
                    <span className={`text-[9px] font-black uppercase tracking-widest block mb-2 opacity-60 ${t.type === 'user' ? 'text-indigo-200' : 'text-slate-400'}`}>
                      {t.type === 'user' ? 'Patient' : 'Receptionist'}
                    </span>
                    <p className="text-sm font-bold leading-relaxed">{t.text}</p>
                    <span className="text-[8px] opacity-40 mt-3 block text-right font-mono font-black">
                      {t.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-10 bg-white border-t border-slate-100 flex flex-col items-center gap-8 relative z-20">
            <div className="flex items-center gap-12">
              {status === AppStatus.IDLE || status === AppStatus.ERROR ? (
                <button
                  onClick={handleStart}
                  className="w-24 h-24 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full flex items-center justify-center shadow-2xl transition-all transform active:scale-90 group relative"
                >
                  <div className="absolute inset-0 rounded-full bg-indigo-600 animate-pulse-custom opacity-25 group-hover:opacity-40" />
                  <svg className="w-10 h-10 group-hover:scale-110 transition-transform relative z-10" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" /></svg>
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className={`w-16 h-16 rounded-3xl border-2 flex items-center justify-center transition-all transform hover:rotate-2 ${
                      isMuted ? 'bg-rose-50 border-rose-200 text-rose-500 shadow-xl shadow-rose-100' : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {isMuted ? (
                      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3zM3 3l18 18" /></svg>
                    ) : (
                      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    )}
                  </button>

                  <button
                    onClick={() => handleStop()}
                    className="w-24 h-24 bg-rose-500 hover:bg-rose-600 text-white rounded-full flex items-center justify-center shadow-2xl transition-all transform active:scale-90 ring-8 ring-rose-50"
                  >
                    <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" /></svg>
                  </button>
                  
                  <div className="w-16 h-16 flex items-center justify-center">
                    <div className="flex gap-2 h-8 items-center">
                      {[1,2,3,4,5].map(i => (
                        <div key={i} className={`w-1 rounded-full bg-indigo-600 transition-all duration-300 ${status === AppStatus.CONNECTED && !isMuted && !isProcessing ? 'animate-bounce' : 'h-1'}`} style={{ animationDelay: `${i*0.08}s`, animationDuration: '0.8s', height: status === AppStatus.CONNECTED && !isMuted && !isProcessing ? '100%' : '4px' }} />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em] text-center">
              {status === AppStatus.CONNECTED ? (isMuted ? 'Line Muted' : 'Human-like turn-taking active') : status === AppStatus.ERROR ? 'Tap to Reconnect' : 'Connect to Canada Care'}
            </p>
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
