// tools/tts/mp3-to-pcm.cs
//
// 用 Windows **Media Foundation Source Reader** 把 MP3 解码为 **16-bit PCM WAV**。
//
// 为什么需要它：无密钥在线 TTS 端点（百度 fanyi gettts）返回 audio/mpeg，
// 而 HAP 需要 16-bit PCM WAV；本机没有 ffmpeg / sox，因此直接用系统自带的
// Media Foundation 解码，不新增任何第三方依赖、不联网、不读凭据。
//
// 编译（见 tools/tts/README.md）：
//   csc.exe /nologo /target:exe /out:mp3-to-pcm.exe mp3-to-pcm.cs
//
// 用法：
//   mp3-to-pcm.exe --in <file.mp3> --out <file.wav> [--rate 16000] [--channels 1]
//
// 退出码：0 成功；64 参数错误；70 解码失败。
// 成功时 stdout 输出一行 JSON，含实际采样率/声道/位深/帧数/PCM 字节数。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Mp3ToPcm
{
    private const int MF_VERSION = 0x00020070;

    private static Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    private static Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    private static Guid MF_MT_AUDIO_NUM_CHANNELS = new Guid("37e48bf5-645e-4c5b-89de-ada9e29b696a");
    private static Guid MF_MT_AUDIO_SAMPLES_PER_SECOND = new Guid("5faeeae7-0290-4c31-9e8a-c534f68d9dba");
    private static Guid MF_MT_AUDIO_BLOCK_ALIGNMENT = new Guid("322de230-9eeb-43bd-ab7a-ff412251541d");
    private static Guid MF_MT_AUDIO_AVG_BYTES_PER_SECOND = new Guid("1aab75c8-cfef-451c-ab95-ac034b8e1731");
    private static Guid MF_MT_AUDIO_BITS_PER_SAMPLE = new Guid("f2deb57f-40fa-4764-aa33-ed4f2d1ff669");
    private static Guid MF_MT_ALL_SAMPLES_INDEPENDENT = new Guid("c9173739-5e56-461c-b713-46fb995cb95f");
    private static Guid MF_MT_AUDIO_PREFER_WAVEFORMATEX = new Guid("a901aaba-e037-458a-bdf6-545be2074042");
    private static Guid MF_SOURCE_READER_ENABLE_AUDIO_PROCESSING = new Guid("97fba2a0-f70c-4bcd-8c8a-4f0d2b3f5c6f");

    private static Guid MFAudioFormat_PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
    private static Guid MFMediaType_Audio = new Guid("73647561-0000-0010-8000-00AA00389B71");

    private const int MF_SOURCE_READER_FIRST_AUDIO_STREAM = unchecked((int)0xFFFFFFFD);
    private const int MF_SOURCE_READERF_ENDOFSTREAM = 0x2;
    private const int MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED = 0x4;

    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFAttributes
    {
        [PreserveSig] int GetItem(ref Guid guidKey, IntPtr pValue);
        [PreserveSig] int GetItemType(ref Guid guidKey, out int pType);
        [PreserveSig] int CompareItem(ref Guid guidKey, IntPtr value, out int pbResult);
        [PreserveSig] int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        [PreserveSig] int GetUINT32(ref Guid guidKey, out int punValue);
        [PreserveSig] int GetUINT64(ref Guid guidKey, out long punValue);
        [PreserveSig] int GetDouble(ref Guid guidKey, out double pfValue);
        [PreserveSig] int GetGUID(ref Guid guidKey, out Guid pguidValue);
        [PreserveSig] int GetStringLength(ref Guid guidKey, out int pcchLength);
        [PreserveSig] int GetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszValue, int cchBufSize, out int pcchLength);
        [PreserveSig] int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        [PreserveSig] int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        [PreserveSig] int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, out int pcbBlobSize);
        [PreserveSig] int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        [PreserveSig] int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem(ref Guid guidKey, IntPtr value);
        [PreserveSig] int DeleteItem(ref Guid guidKey);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32(ref Guid guidKey, int unValue);
        [PreserveSig] int SetUINT64(ref Guid guidKey, long unValue);
        [PreserveSig] int SetDouble(ref Guid guidKey, double fValue);
        [PreserveSig] int SetGUID(ref Guid guidKey, ref Guid guidValue);
        [PreserveSig] int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        [PreserveSig] int SetBlob(ref Guid guidKey, byte[] pBuf, int cbBufSize);
        [PreserveSig] int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int pcItems);
        [PreserveSig] int GetItemByIndex(int unIndex, out Guid pguidKey, IntPtr pValue);
        [PreserveSig] int CopyAllItems(IMFAttributes pDest);
    }

    [ComImport, Guid("70ae66f2-c809-4e4f-8915-bdcb406b7993"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFSourceReader
    {
        [PreserveSig] int GetStreamSelection(int dwStreamIndex, out int pfSelected);
        [PreserveSig] int SetStreamSelection(int dwStreamIndex, int fSelected);
        [PreserveSig] int GetNativeMediaType(int dwStreamIndex, int dwMediaTypeIndex, out IMFMediaType ppMediaType);
        [PreserveSig] int GetCurrentMediaType(int dwStreamIndex, out IMFMediaType ppMediaType);
        [PreserveSig] int SetCurrentMediaType(int dwStreamIndex, IntPtr pdwReserved, IMFMediaType pMediaType);
        [PreserveSig] int SetCurrentPosition(ref Guid guidTimeFormat, IntPtr varPosition);
        [PreserveSig] int ReadSample(int dwStreamIndex, int dwControlFlags, out int pdwActualStreamIndex,
            out int pdwStreamFlags, out long pllTimestamp, out IMFSample ppSample);
        [PreserveSig] int Flush(int dwStreamIndex);
        [PreserveSig] int GetServiceForStream(int dwStreamIndex, ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
        [PreserveSig] int GetPresentationAttribute(int dwStreamIndex, ref Guid guidAttribute, IntPtr pvarAttribute);
    }

    [ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFMediaType
    {
        [PreserveSig] int GetItem(ref Guid guidKey, IntPtr pValue);
        [PreserveSig] int GetItemType(ref Guid guidKey, out int pType);
        [PreserveSig] int CompareItem(ref Guid guidKey, IntPtr value, out int pbResult);
        [PreserveSig] int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        [PreserveSig] int GetUINT32(ref Guid guidKey, out int punValue);
        [PreserveSig] int GetUINT64(ref Guid guidKey, out long punValue);
        [PreserveSig] int GetDouble(ref Guid guidKey, out double pfValue);
        [PreserveSig] int GetGUID(ref Guid guidKey, out Guid pguidValue);
        [PreserveSig] int GetStringLength(ref Guid guidKey, out int pcchLength);
        [PreserveSig] int GetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszValue, int cchBufSize, out int pcchLength);
        [PreserveSig] int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        [PreserveSig] int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        [PreserveSig] int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, out int pcbBlobSize);
        [PreserveSig] int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        [PreserveSig] int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem(ref Guid guidKey, IntPtr value);
        [PreserveSig] int DeleteItem(ref Guid guidKey);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32(ref Guid guidKey, int unValue);
        [PreserveSig] int SetUINT64(ref Guid guidKey, long unValue);
        [PreserveSig] int SetDouble(ref Guid guidKey, double fValue);
        [PreserveSig] int SetGUID(ref Guid guidKey, ref Guid guidValue);
        [PreserveSig] int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        [PreserveSig] int SetBlob(ref Guid guidKey, byte[] pBuf, int cbBufSize);
        [PreserveSig] int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int pcItems);
        [PreserveSig] int GetItemByIndex(int unIndex, out Guid pguidKey, IntPtr pValue);
        [PreserveSig] int CopyAllItems(IMFAttributes pDest);
        [PreserveSig] int GetMajorType(out Guid pguidMajorType);
        [PreserveSig] int IsCompressedFormat(out int pfCompressed);
        [PreserveSig] int IsEqual(IMFMediaType pIMediaType, out int pdwFlags);
        [PreserveSig] int GetRepresentation(ref Guid guidRepresentation, out IntPtr ppvRepresentation);
        [PreserveSig] int FreeRepresentation(ref Guid guidRepresentation, IntPtr pvRepresentation);
    }

    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFSample
    {
        [PreserveSig] int GetItem(ref Guid guidKey, IntPtr pValue);
        [PreserveSig] int GetItemType(ref Guid guidKey, out int pType);
        [PreserveSig] int CompareItem(ref Guid guidKey, IntPtr value, out int pbResult);
        [PreserveSig] int Compare(IMFAttributes pTheirs, int matchType, out int pbResult);
        [PreserveSig] int GetUINT32(ref Guid guidKey, out int punValue);
        [PreserveSig] int GetUINT64(ref Guid guidKey, out long punValue);
        [PreserveSig] int GetDouble(ref Guid guidKey, out double pfValue);
        [PreserveSig] int GetGUID(ref Guid guidKey, out Guid pguidValue);
        [PreserveSig] int GetStringLength(ref Guid guidKey, out int pcchLength);
        [PreserveSig] int GetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszValue, int cchBufSize, out int pcchLength);
        [PreserveSig] int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out int pcchLength);
        [PreserveSig] int GetBlobSize(ref Guid guidKey, out int pcbBlobSize);
        [PreserveSig] int GetBlob(ref Guid guidKey, IntPtr pBuf, int cbBufSize, out int pcbBlobSize);
        [PreserveSig] int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out int pcbSize);
        [PreserveSig] int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem(ref Guid guidKey, IntPtr var);
        [PreserveSig] int DeleteItem(ref Guid guidKey);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32(ref Guid guidKey, int unValue);
        [PreserveSig] int SetUINT64(ref Guid guidKey, long unValue);
        [PreserveSig] int SetDouble(ref Guid guidKey, double fValue);
        [PreserveSig] int SetGUID(ref Guid guidKey, ref Guid guidValue);
        [PreserveSig] int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        [PreserveSig] int SetBlob(ref Guid guidKey, byte[] pBuf, int cbBufSize);
        [PreserveSig] int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out int pcItems);
        [PreserveSig] int GetItemByIndex(int unIndex, out Guid pguidKey, IntPtr pValue);
        [PreserveSig] int CopyAllItems(IMFAttributes pDest);
        [PreserveSig] int GetSampleFlags(out int pdwSampleFlags);
        [PreserveSig] int SetSampleFlags(int dwSampleFlags);
        [PreserveSig] int GetSampleTime(out long phnsSampleTime);
        [PreserveSig] int SetSampleTime(long hnsSampleTime);
        [PreserveSig] int GetSampleDuration(out long phnsSampleDuration);
        [PreserveSig] int SetSampleDuration(long hnsSampleDuration);
        [PreserveSig] int GetBufferCount(out int pdwBufferCount);
        [PreserveSig] int GetBufferByIndex(int dwIndex, out IMFMediaBuffer ppBuffer);
        [PreserveSig] int ConvertToContiguousBuffer(out IMFMediaBuffer ppBuffer);
        [PreserveSig] int AddBuffer(IMFMediaBuffer pBuffer);
        [PreserveSig] int RemoveBufferByIndex(int dwIndex);
        [PreserveSig] int RemoveAllBuffers();
        [PreserveSig] int GetTotalLength(out int pcbTotalLength);
        [PreserveSig] int CopyToBuffer(IMFMediaBuffer pBuffer);
    }

    [ComImport, Guid("045fa593-8799-42b8-bc8d-8968c6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFMediaBuffer
    {
        [PreserveSig] int Lock(out IntPtr ppbBuffer, out int pcbMaxLength, out int pcbCurrentLength);
        [PreserveSig] int Unlock();
        [PreserveSig] int GetCurrentLength(out int pcbCurrentLength);
        [PreserveSig] int SetCurrentLength(int cbCurrentLength);
        [PreserveSig] int GetMaxLength(out int pcbMaxLength);
    }

    [DllImport("mfplat.dll")] private static extern int MFStartup(int version, int dwFlags);
    [DllImport("mfplat.dll")] private static extern int MFShutdown();
    [DllImport("mfplat.dll")] private static extern int MFCreateMediaType(out IMFMediaType ppMFType);
    [DllImport("mfplat.dll")] private static extern int MFCreateAttributes(out IMFAttributes ppMFAttributes, int cInitialSize);
    // 直接从文件路径创建 Source Reader（比从 IStream 更稳：
    // 从 SHCreateStreamOnFileEx 的 IStream 创建会返回 E_INVALIDARG 0x80070057）。
    [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode)]
    private static extern int MFCreateSourceReaderFromURL(
        string pwszURL, IMFAttributes pAttributes, out IMFSourceReader ppSourceReader);

    private static int Main(string[] args)
    {
        string inFile = string.Empty;
        string outFile = string.Empty;
        int targetRate = 16000;
        int targetChannels = 1;

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--in": if (i + 1 < args.Length) inFile = args[++i]; break;
                case "--out": if (i + 1 < args.Length) outFile = args[++i]; break;
                case "--rate":
                    if (i + 1 < args.Length) int.TryParse(args[++i], NumberStyles.Integer, CultureInfo.InvariantCulture, out targetRate);
                    break;
                case "--channels":
                    if (i + 1 < args.Length) int.TryParse(args[++i], NumberStyles.Integer, CultureInfo.InvariantCulture, out targetChannels);
                    break;
                default:
                    Console.Error.WriteLine("unknown argument: " + args[i]);
                    return 64;
            }
        }

        if (inFile.Length == 0 || outFile.Length == 0)
        {
            Console.Error.WriteLine("usage: mp3-to-pcm.exe --in <file.mp3> --out <file.wav> [--rate 16000] [--channels 1]");
            return 64;
        }
        if (!File.Exists(inFile))
        {
            Console.Error.WriteLine("input not found: " + inFile);
            return 64;
        }
        if (targetRate < 8000 || targetRate > 48000 || (targetChannels != 1 && targetChannels != 2))
        {
            Console.Error.WriteLine("unsupported target rate/channels");
            return 64;
        }

        int hr = MFStartup(MF_VERSION, 0);
        if (hr != 0)
        {
            Console.Error.WriteLine("MFStartup 0x" + hr.ToString("X8"));
            return 70;
        }

        IMFSourceReader reader = null;
        IMFAttributes readerAttributes = null;
        IMFMediaType outputType = null;
        List<byte[]> chunks = new List<byte[]>();

        try
        {
            hr = MFCreateAttributes(out readerAttributes, 2);
            if (hr != 0) throw new InvalidOperationException("MFCreateAttributes 0x" + hr.ToString("X8"));
            Guid audioProcessing = MF_SOURCE_READER_ENABLE_AUDIO_PROCESSING;
            readerAttributes.SetUINT32(ref audioProcessing, 1);

            hr = MFCreateSourceReaderFromURL(Path.GetFullPath(inFile), readerAttributes, out reader);
            if (hr != 0) throw new InvalidOperationException("MFCreateSourceReaderFromURL 0x" + hr.ToString("X8"));

            hr = MFCreateMediaType(out outputType);
            if (hr != 0) throw new InvalidOperationException("MFCreateMediaType 0x" + hr.ToString("X8"));

            Guid major = MFMediaType_Audio;
            Guid pcm = MFAudioFormat_PCM;
            outputType.SetGUID(ref MF_MT_MAJOR_TYPE, ref major);
            outputType.SetGUID(ref MF_MT_SUBTYPE, ref pcm);
            outputType.SetUINT32(ref MF_MT_AUDIO_NUM_CHANNELS, targetChannels);
            outputType.SetUINT32(ref MF_MT_AUDIO_SAMPLES_PER_SECOND, targetRate);
            outputType.SetUINT32(ref MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
            outputType.SetUINT32(ref MF_MT_AUDIO_BLOCK_ALIGNMENT, targetChannels * 2);
            outputType.SetUINT32(ref MF_MT_AUDIO_AVG_BYTES_PER_SECOND, targetRate * targetChannels * 2);
            outputType.SetUINT32(ref MF_MT_ALL_SAMPLES_INDEPENDENT, 1);
            outputType.SetUINT32(ref MF_MT_AUDIO_PREFER_WAVEFORMATEX, 1);

            hr = reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, IntPtr.Zero, outputType);
            if (hr != 0) throw new InvalidOperationException("SetCurrentMediaType(PCM) 0x" + hr.ToString("X8"));

            while (true)
            {
                int actualStreamIndex;
                int streamFlags;
                long timestamp;
                IMFSample sample;
                hr = reader.ReadSample(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, out actualStreamIndex,
                    out streamFlags, out timestamp, out sample);
                if (hr != 0) throw new InvalidOperationException("ReadSample 0x" + hr.ToString("X8"));

                if ((streamFlags & MF_SOURCE_READERF_ENDOFSTREAM) != 0)
                {
                    if (sample != null) Marshal.ReleaseComObject(sample);
                    break;
                }
                if (sample == null) continue;
                if ((streamFlags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) != 0)
                {
                    Marshal.ReleaseComObject(sample);
                    continue;
                }

                try
                {
                    IMFMediaBuffer buffer;
                    hr = sample.ConvertToContiguousBuffer(out buffer);
                    if (hr != 0) throw new InvalidOperationException("ConvertToContiguousBuffer 0x" + hr.ToString("X8"));
                    try
                    {
                        IntPtr data;
                        int maxLength;
                        int currentLength;
                        hr = buffer.Lock(out data, out maxLength, out currentLength);
                        if (hr != 0) throw new InvalidOperationException("Lock 0x" + hr.ToString("X8"));
                        try
                        {
                            if (currentLength > 0)
                            {
                                byte[] copy = new byte[currentLength];
                                Marshal.Copy(data, copy, 0, currentLength);
                                chunks.Add(copy);
                            }
                        }
                        finally { buffer.Unlock(); }
                    }
                    finally { Marshal.ReleaseComObject(buffer); }
                }
                finally { Marshal.ReleaseComObject(sample); }
            }

            int actualRate = targetRate;
            int actualChannels = targetChannels;
            int actualBits = 16;
            IMFMediaType currentType;
            if (reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, out currentType) == 0 && currentType != null)
            {
                int value;
                if (currentType.GetUINT32(ref MF_MT_AUDIO_SAMPLES_PER_SECOND, out value) == 0) actualRate = value;
                if (currentType.GetUINT32(ref MF_MT_AUDIO_NUM_CHANNELS, out value) == 0) actualChannels = value;
                if (currentType.GetUINT32(ref MF_MT_AUDIO_BITS_PER_SAMPLE, out value) == 0) actualBits = value;
                Marshal.ReleaseComObject(currentType);
            }

            int total = 0;
            for (int i = 0; i < chunks.Count; i++) total += chunks[i].Length;
            if (total == 0) throw new InvalidOperationException("decoder produced no PCM data");

            byte[] pcmBytes = new byte[total];
            int offset = 0;
            for (int i = 0; i < chunks.Count; i++)
            {
                Buffer.BlockCopy(chunks[i], 0, pcmBytes, offset, chunks[i].Length);
                offset += chunks[i].Length;
            }

            WriteWav(outFile, pcmBytes, actualRate, actualChannels, actualBits);

            Console.Out.WriteLine("{\"sampleRate\":" + actualRate +
                ",\"channels\":" + actualChannels +
                ",\"bitsPerSample\":" + actualBits +
                ",\"pcmBytes\":" + total +
                ",\"durationSeconds\":" + ((double)total / (actualRate * actualChannels * (actualBits / 8))).ToString("F4", CultureInfo.InvariantCulture) +
                "}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("MP3_DECODE_FAILED: " + error.GetType().Name + " :: " + error.Message);
            return 70;
        }
        finally
        {
            if (outputType != null) Marshal.ReleaseComObject(outputType);
            if (readerAttributes != null) Marshal.ReleaseComObject(readerAttributes);
            if (reader != null) Marshal.ReleaseComObject(reader);
            MFShutdown();
        }
    }

    /// <summary>写出标准 RIFF/WAVE（16-bit PCM）。</summary>
    private static void WriteWav(string path, byte[] pcm, int sampleRate, int channels, int bitsPerSample)
    {
        int blockAlign = channels * (bitsPerSample / 8);
        int byteRate = sampleRate * blockAlign;
        string full = Path.GetFullPath(path);
        string directory = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }
        using (FileStream stream = new FileStream(full, FileMode.Create, FileAccess.Write))
        using (BinaryWriter writer = new BinaryWriter(stream))
        {
            writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            writer.Write(36 + pcm.Length);
            writer.Write(Encoding.ASCII.GetBytes("WAVE"));
            writer.Write(Encoding.ASCII.GetBytes("fmt "));
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)channels);
            writer.Write(sampleRate);
            writer.Write(byteRate);
            writer.Write((short)blockAlign);
            writer.Write((short)bitsPerSample);
            writer.Write(Encoding.ASCII.GetBytes("data"));
            writer.Write(pcm.Length);
            writer.Write(pcm);
        }
    }
}
