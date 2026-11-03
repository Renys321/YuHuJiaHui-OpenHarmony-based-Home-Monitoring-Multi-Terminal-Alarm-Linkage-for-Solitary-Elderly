// tools/tts/synth-wav.cs
//
// 离线普通话 WAV 合成器：直接用 Windows SAPI 5 的**原始 COM 接口**。
// 不需要网络、不需要密钥、不做任何在线 TTS。
//
// 为什么不用 System.Speech：
//   本机 .NET Framework 4.0 的 System.Speech 调用 SAPI 时会直接崩进程
//   （实测退出码 -1073741819 / 0xC0000005，不可捕获）；原始 COM 可用。
//
// 输出格式：
//   SpFileStream 默认写出 22.05 kHz / 16-bit / 单声道 PCM WAV。
//   最终仓库里的资源由 tools/tts/normalize-wav.js 归一化为
//   16 kHz / 16-bit / 单声道 PCM，并校验头部、时长与非静音能量。
//
// 编译（见 tools/tts/README.md）：
//   csc.exe /nologo /target:exe /out:synth-wav.exe synth-wav.cs
//
// 用法：
//   synth-wav.exe --list
//   synth-wav.exe <voiceTokenOrName> <rate> <outFile> <text...>

using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

[ComImport, Guid("6C44DF74-72B9-4992-A1EC-EF996E0422D4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ISpVoice
{
    [PreserveSig] int SetNotifySink(IntPtr pSink);
    [PreserveSig] int SetNotifyWindowMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [PreserveSig] int SetNotifyCallbackFunction(IntPtr cb, IntPtr wParam, IntPtr lParam);
    [PreserveSig] int SetNotifyCallbackInterface(IntPtr cb, IntPtr wParam, IntPtr lParam);
    [PreserveSig] int SetNotifyWin32Event();
    [PreserveSig] int WaitForNotifyEvent(int dwMilliseconds);
    [PreserveSig] int GetNotifyEventHandle(out IntPtr h);
    [PreserveSig] int SetInterest(long ullEventInterest, long ullQueuedInterest);
    [PreserveSig] int GetEvents(uint ulCount, IntPtr pEventArray, out uint pulFetched);
    [PreserveSig] int GetInfo(out IntPtr pInfo);
    // SVSFDefault=0 表示纯文本（不做 XML/SSML 解析，避免把正文当标记处理）
    [PreserveSig] int Speak([MarshalAs(UnmanagedType.LPWStr)] string pwcs, uint dwFlags, out uint pulStreamNumber);
    [PreserveSig] int SetPriority(int ePriority);
    [PreserveSig] int GetPriority(out int pePriority);
    [PreserveSig] int SetAlertBoundary(int eBoundary);
    [PreserveSig] int GetAlertBoundary(out int peBoundary);
    [PreserveSig] int SetRate(int rateAdjust);
    [PreserveSig] int GetRate(out int pRateAdjust);
    [PreserveSig] int SetVolume(ushort usVolume);
    [PreserveSig] int GetVolume(out ushort pusVolume);
    [PreserveSig] int WaitUntilDone(int msTimeout);
    [PreserveSig] int SetSyncSpeakTimeout(int msTimeout);
    [PreserveSig] int GetSyncSpeakTimeout(out int pmsTimeout);
    [PreserveSig] int SpeakCompleteEvent(out IntPtr handle);
    [PreserveSig] int IsUISupported([MarshalAs(UnmanagedType.LPWStr)] string pszTypeOfUI,
        IntPtr pvExtraData, uint cbExtraData, out int pfSupported);
    [PreserveSig] int DisplayUI(IntPtr hWndParent, [MarshalAs(UnmanagedType.LPWStr)] string pszTitle,
        [MarshalAs(UnmanagedType.LPWStr)] string pszTypeOfUI, IntPtr pvExtraData, uint cbExtraData);
    [PreserveSig] int SetOutput(IntPtr pUnkOutput, int fAllowFormatChanges);
}

internal static class SynthWav
{
    private const int S_OK = 0;
    private const int SPF_FALSE = 0;
    private const uint SPF_DEFAULT = 0;        // 纯文本
    private const uint SPF_PURGEBEFORESPEAK = 2;

    private static readonly Type VoiceType = Type.GetTypeFromProgID("SAPI.SpVoice");
    private static readonly Type FileStreamType = Type.GetTypeFromProgID("SAPI.SpFileStream");

    // SAPI 的 COM 组件要求 STA；缺这个特性会直接崩进程而不是抛异常。
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 0) { Usage(); return 64; }
        if (args[0] == "--list") return ListVoices();
        if (args.Length < 4) { Usage(); return 64; }

        if (VoiceType == null || FileStreamType == null)
        {
            Console.Error.WriteLine("SAPI COM not available (SAPI.SpVoice / SAPI.SpFileStream)");
            return 69;
        }

        string voiceFilter = args[0];
        int rate;
        if (!int.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out rate) || rate < -10 || rate > 10)
        {
            Console.Error.WriteLine("rate must be an integer within [-10, 10]");
            return 64;
        }
        string outFile = args[2];
        string text = string.Join(" ", args, 3, args.Length - 3);
        if (text.Trim().Length == 0)
        {
            Console.Error.WriteLine("text must not be empty");
            return 64;
        }

        string full = Path.GetFullPath(outFile);
        string dir = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        if (File.Exists(full)) File.Delete(full);

        object voiceObj = null;
        object streamObj = null;
        try
        {
            voiceObj = Activator.CreateInstance(VoiceType);
            ISpVoice voice = (ISpVoice)voiceObj;

            if (voiceFilter != "-")
            {
                if (!SelectVoice(voiceObj, voiceFilter))
                {
                    Console.Error.WriteLine("voice not found: " + voiceFilter);
                    return 65;
                }
            }

            int hr = voice.SetRate(rate);
            if (hr != S_OK) { Console.Error.WriteLine("SetRate failed: 0x" + hr.ToString("X8")); return 70; }

            // SpFileStream 的默认格式：22.05 kHz / 16-bit / 单声道 PCM。
            streamObj = Activator.CreateInstance(FileStreamType);
            IntPtr streamUnk = Marshal.GetIUnknownForObject(streamObj);
            try
            {
                hr = voice.SetOutput(streamUnk, SPF_FALSE);
            }
            finally
            {
                Marshal.Release(streamUnk);
            }
            if (hr != S_OK) { Console.Error.WriteLine("SetOutput failed: 0x" + hr.ToString("X8")); return 72; }

            uint streamNumber;
            hr = voice.Speak(text, SPF_DEFAULT | SPF_PURGEBEFORESPEAK, out streamNumber);
            if (hr != S_OK) { Console.Error.WriteLine("Speak failed: 0x" + hr.ToString("X8")); return 73; }

            hr = voice.WaitUntilDone(120000);
            if (hr != S_OK) { Console.Error.WriteLine("WaitUntilDone failed: 0x" + hr.ToString("X8")); return 75; }

            // 先把输出从流上摘下来，再释放流对象，确保 WAV 头补完整。
            voice.SetOutput(IntPtr.Zero, SPF_FALSE);
            Marshal.ReleaseComObject(streamObj);
            streamObj = null;

            if (!File.Exists(full) || new FileInfo(full).Length <= 44)
            {
                Console.Error.WriteLine("output file is missing or has no audio data");
                return 76;
            }

            Console.Out.WriteLine("OK " + outFile);
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("synth failed: " + e.GetType().Name + " hresult=0x" + e.HResult.ToString("X8"));
            return 74;
        }
        finally
        {
            if (streamObj != null) { try { Marshal.ReleaseComObject(streamObj); } catch { } }
            if (voiceObj != null) { try { Marshal.ReleaseComObject(voiceObj); } catch { } }
        }
    }

    private static void Usage()
    {
        Console.Error.WriteLine("usage:");
        Console.Error.WriteLine("  synth-wav.exe --list");
        Console.Error.WriteLine("  synth-wav.exe <voiceTokenOrName> <rate> <outFile> <text...>");
    }

    private static int ListVoices()
    {
        if (VoiceType == null) { Console.Error.WriteLine("SAPI COM not available"); return 69; }
        object voice = null;
        try
        {
            voice = Activator.CreateInstance(VoiceType);
            dynamic d = voice;
            dynamic tokens = d.GetVoices();
            int count = (int)tokens.Count;
            for (int i = 0; i < count; i++)
            {
                dynamic token = tokens.Item(i);
                Console.Out.WriteLine(((string)token.GetDescription()) + "\t" + ((string)token.Id));
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("list failed: " + e.Message);
            return 74;
        }
        finally
        {
            if (voice != null) { try { Marshal.ReleaseComObject(voice); } catch { } }
        }
    }

    /// <summary>按描述名、Voice.Id 或描述子串选择一个已安装语音。</summary>
    private static bool SelectVoice(object voiceObj, string filter)
    {
        dynamic d = voiceObj;
        dynamic tokens = d.GetVoices();
        int count = (int)tokens.Count;
        for (int i = 0; i < count; i++)
        {
            dynamic token = tokens.Item(i);
            string description = (string)token.GetDescription();
            string id = (string)token.Id;
            if (string.Equals(description, filter, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(id, filter, StringComparison.OrdinalIgnoreCase) ||
                description.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                d.Voice = token;
                return true;
            }
        }
        return false;
    }
}
