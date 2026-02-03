
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { AppStatus, TranscriptionEntry } from './types';
import { encode, decode, decodeAudioData } from './utils/audio';

const HOSPITAL_NAME = "Canada Care Hospital";
const SYSTEM_INSTRUCTION = `
You are a professional, calm, and patient MULTILINGUAL hospital receptionist for ${HOSPITAL_NAME}.

====================
STABILITY RULES (CRITICAL)
====================
- DO NOT INTERRUPT: Be extremely patient. If there is silence, wait at least 2 seconds before assuming the user is done.
- STAY ACTIVE: Do not end the session or stop responding. If a user's intent is unclear, ask for clarification in their language.
- PROCESSING: If you are "thinking," it is okay to take a moment, but do not close the connection.

====================
MULTILINGUAL PROTOCOL
====================
1. Detect the user's language (Tamil, Hindi, Bengali, English, etc.) and respond fluently in that SAME language.
2. If the user switches languages, switch with them immediately.

====================
PRIVACY & BOOKING
====================
- Never ask for Health IDs, Insurance, or Credit Cards. 
- Sequence: Name -> Department -> Date -> Time -> Phone.
- Confirmed details must be summarized at the end.
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
  
  // Audio Recording Refs
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mixerRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Persistent refs for audio nodes to prevent Garbage Collection
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  
  const transcriptionBufferRef = useRef({ user: '', agent: '' });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions]);

  const downloadTranscript = useCallback(() => {
    if (transcriptions.length === 0) return;
    const content = transcriptions.map(t => {
      const time = t.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const role = t.type === 'user' ? 'Patient' : 'Receptionist';
      return `[${time}] ${role}: ${t.text}`;
    }).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canada-care-transcript-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [transcriptions]);

  const downloadAudio = useCallback(() => {
    if (!audioUrlRef.current) return;
    const a = document.createElement('a');
    a.href = audioUrlRef.current;
    a.download = `hospital-call-recording-${Date.now()}.webm`;
    a.click();
  }, []);

  const handleStop = useCallback(() => {
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(session => {
        try { session.close(); } catch(e) {}
      });
      sessionPromiseRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
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
    setStatus(AppStatus.IDLE);
    setIsProcessing(false);
  }, []);

  const handleStart = async () => {
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

      // Create Mixer for Call Recording
      const mixer = outputAudioContextRef.current.createMediaStreamDestination();
      mixerRef.current = mixer;

      // Connect user mic to mixer
      const micSource = outputAudioContextRef.current.createMediaStreamSource(stream);
      micSource.connect(mixer);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setStatus(AppStatus.CONNECTED);
            // Start MediaRecorder
            const recorder = new MediaRecorder(mixer.stream);
            recorder.ondataavailable = (e) => {
              if (e.data.size > 0) recordedChunksRef.current.push(e.data);
            };
            recorder.onstop = () => {
              const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
              audioUrlRef.current = URL.createObjectURL(blob);
              setHasAudioData(true);
            };
            recorder.start();
            recorderRef.current = recorder;
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.find(p => p.inlineData)?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              setIsProcessing(false);
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const buffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              
              // Connect to speakers AND mixer
              source.connect(ctx.destination);
              source.connect(mixerRef.current!);
              
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
          onerror: (e) => {
            console.error("Session Error:", e);
            setErrorMessage("Network issue. Reconnecting...");
            handleStop();
          },
          onclose: () => handleStop()
        }
      });
      
      sessionPromiseRef.current = sessionPromise;

      // Audio stream to Gemini
      const source = audioContextRef.current!.createMediaStreamSource(stream);
      const processor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
      sourceNodeRef.current = source;
      processorNodeRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMuted) return;
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
          session.sendRealtimeInput({ media: pcmBlob });
        });
      };

      source.connect(processor);
      processor.connect(audioContextRef.current!.destination);

    } catch (err) {
      console.error("Startup Error:", err);
      setErrorMessage("Microphone access failed.");
      setStatus(AppStatus.IDLE);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 md:p-8 bg-slate-100">
      <div className="w-full max-w-5xl h-[85vh] grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* Sidebar */}
        <aside className="lg:col-span-1 flex flex-col gap-4">
          <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-200">
            <div className="flex items-center gap-3 mb-6">
              <div className="bg-indigo-600 p-2 rounded-xl text-white">
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0V6H8a1 1 0 010-2h1V3a1 1 0 011-1z" /><path d="M4 8a1 1 0 011-1h10a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1V8zm2 2v2h2v-2H6zm5 0v2h2v-2h-2zm-5 4v2h2v-2H6zm5 0v2h2v-2h-2z" /></svg>
              </div>
              <h1 className="text-lg font-bold text-slate-800">Canada Care</h1>
            </div>

            <div className="space-y-2">
              <button 
                onClick={downloadTranscript}
                disabled={transcriptions.length === 0}
                className="w-full py-2.5 bg-indigo-50 text-indigo-700 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-100 disabled:opacity-30 transition-all flex items-center justify-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Transcript
              </button>

              <button 
                onClick={downloadAudio}
                disabled={!hasAudioData}
                className="w-full py-2.5 bg-emerald-50 text-emerald-700 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-100 disabled:opacity-30 transition-all flex items-center justify-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                Recording
              </button>
            </div>

            <div className="space-y-3 pt-6 border-t border-slate-100 mt-4">
              <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Departments</h3>
              <div className="flex flex-wrap gap-1.5">
                {['General', 'Cardio', 'Ortho', 'Peds'].map(d => (
                  <span key={d} className="px-2 py-0.5 bg-slate-50 text-slate-500 rounded-md border border-slate-200 text-[10px] font-bold uppercase">{d}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-indigo-600 rounded-3xl p-5 shadow-lg text-white flex-1 flex flex-col justify-between overflow-hidden relative">
            <div>
              <h3 className="text-sm font-bold mb-1">Receptionist Live</h3>
              <p className="text-[11px] text-indigo-100 leading-relaxed">Multilingual session recording is currently enabled.</p>
            </div>
            <div className="bg-white/10 px-3 py-2 rounded-xl border border-white/5 z-10">
              <span className="text-[9px] font-bold uppercase block opacity-60 mb-1">Status</span>
              <div className="flex items-center gap-2">
                <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${status === AppStatus.CONNECTED ? 'bg-green-400' : 'bg-slate-400'}`} />
                <span className="text-[10px] font-bold uppercase">{status}</span>
              </div>
            </div>
            <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-white/5 rounded-full blur-2xl" />
          </div>
        </aside>

        {/* Conversation Terminal */}
        <main className="lg:col-span-3 bg-white rounded-3xl shadow-xl border border-slate-200 flex flex-col overflow-hidden">
          
          {/* Header Status Bar */}
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${status === AppStatus.CONNECTED ? 'bg-green-500 animate-pulse' : status === AppStatus.CONNECTING ? 'bg-amber-400 animate-bounce' : 'bg-slate-300'}`} />
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
                {status === AppStatus.CONNECTED ? 'Call in Progress' : 'System Idle'}
              </span>
            </div>
            {isProcessing && (
              <span className="text-[9px] font-black text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded uppercase animate-pulse">
                Thinking...
              </span>
            )}
            {errorMessage && (
              <span className="text-[10px] font-bold text-rose-500 bg-rose-50 px-3 py-1 rounded-full border border-rose-100">
                {errorMessage}
              </span>
            )}
          </div>

          {/* Transcript Scroll Area */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50/20">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-xs mx-auto opacity-30">
                <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-6">
                  <svg className="w-10 h-10 text-slate-400" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" /></svg>
                </div>
                <h4 className="text-sm font-bold text-slate-800 mb-1">Secure Reception Line</h4>
                <p className="text-[11px] font-medium leading-relaxed">Language is detected automatically. Tap the phone to start call.</p>
              </div>
            ) : (
              transcriptions.map((t, i) => (
                <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2`}>
                  <div className={`max-w-[75%] px-5 py-3.5 rounded-2xl shadow-sm border ${
                    t.type === 'user' 
                      ? 'bg-indigo-600 text-white border-indigo-500 rounded-tr-none' 
                      : 'bg-white text-slate-700 border-slate-200 rounded-tl-none'
                  }`}>
                    <span className="text-[9px] font-black uppercase tracking-widest opacity-60 block mb-1">
                      {t.type === 'user' ? 'Patient' : 'Receptionist'}
                    </span>
                    <p className="text-sm font-medium leading-snug">{t.text}</p>
                    <span className="text-[8px] opacity-40 mt-1.5 block text-right font-mono">
                      {t.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Action Bar */}
          <div className="p-8 bg-white border-t border-slate-100 flex flex-col items-center gap-6">
            <div className="flex items-center gap-10">
              {status === AppStatus.IDLE || status === AppStatus.ERROR ? (
                <button
                  onClick={handleStart}
                  className="w-24 h-24 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full flex items-center justify-center shadow-2xl transition-all transform active:scale-95 group relative"
                >
                  <div className="absolute inset-0 rounded-full bg-indigo-600 animate-ping opacity-10 group-hover:opacity-20" />
                  <svg className="w-10 h-10 group-hover:scale-110 transition-transform relative z-10" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" /></svg>
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className={`w-16 h-16 rounded-full border-2 flex items-center justify-center transition-all ${
                      isMuted ? 'bg-rose-50 border-rose-200 text-rose-500 shadow-lg shadow-rose-100' : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {isMuted ? (
                      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3zM3 3l18 18" /></svg>
                    ) : (
                      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    )}
                  </button>

                  <button
                    onClick={handleStop}
                    className="w-24 h-24 bg-rose-500 hover:bg-rose-600 text-white rounded-full flex items-center justify-center shadow-2xl transition-all transform active:scale-95"
                  >
                    <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" /></svg>
                  </button>
                  
                  <div className="w-16 h-16 flex items-center justify-center">
                    <div className="flex gap-1.5">
                      {[1,2,3,4].map(i => (
                        <div key={i} className={`w-1 rounded-full bg-indigo-600 animate-bounce ${i%2===0 ? 'h-6' : 'h-4'}`} style={{ animationDelay: `${i*0.1}s`, animationDuration: '0.8s' }} />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] text-center">
              {status === AppStatus.CONNECTED ? (isMuted ? 'Mic Paused' : 'Voice Link Active') : 'Canada Care Patient Terminal'}
            </p>
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
