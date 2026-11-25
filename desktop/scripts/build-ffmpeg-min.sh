#!/usr/bin/env bash
# Builds a tiny static ffmpeg + ffprobe with only what Memeh MP3 needs
# (MP3 encode via LAME, MP4/M4A/WebM remux, thumbnail embed).
# Usage: TARGET=win64|native ./build-ffmpeg-min.sh <workdir> <outdir>
set -euo pipefail
TARGET="${TARGET:-native}"
WORK="$(realpath "${1:-ffwork}")"; OUT="$(realpath -m "${2:-ffout}")"
FF_VER=7.1.1; LAME_VER=3.100
mkdir -p "$WORK" "$OUT"; cd "$WORK"
[ -f lame.tgz ] || curl -fsSL -o lame.tgz "https://downloads.sourceforge.net/project/lame/lame/$LAME_VER/lame-$LAME_VER.tar.gz"
[ -f zlib.tgz ] || curl -fsSL -o zlib.tgz "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
[ -f ff.tar.xz ] || curl -fsSL -o ff.tar.xz "https://ffmpeg.org/releases/ffmpeg-$FF_VER.tar.xz"
rm -rf "lame-$LAME_VER" "ffmpeg-$FF_VER" zlib-1.3.1 prefix; tar xzf lame.tgz; tar xJf ff.tar.xz; tar xzf zlib.tgz
PREFIX="$WORK/prefix"; mkdir -p "$PREFIX"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
LAME_HOST=(); FF_CROSS=(); EXE=""
if [ "$TARGET" = win64 ]; then
  LAME_HOST=(--host=x86_64-w64-mingw32)
  FF_CROSS=(--enable-cross-compile --arch=x86_64 --target-os=mingw32 --cross-prefix=x86_64-w64-mingw32- --extra-ldflags=-static)
  EXE=".exe"
fi
( cd zlib-1.3.1
  if [ "$TARGET" = win64 ]; then
    make -f win32/Makefile.gcc PREFIX=x86_64-w64-mingw32- libz.a
    mkdir -p "$PREFIX/lib" "$PREFIX/include"; cp libz.a "$PREFIX/lib/"; cp zlib.h zconf.h "$PREFIX/include/"
  else
    ./configure --prefix="$PREFIX" --static && make -j"$JOBS" && make install
  fi )
( cd "lame-$LAME_VER"
  # lame 3.100 lists a symbol that no longer exists
  sed -i.bak '/lame_init_old/d' include/libmp3lame.sym || true
  ./configure "${LAME_HOST[@]}" --prefix="$PREFIX" --enable-static --disable-shared --disable-frontend --disable-decoder --disable-analyzer-hooks --disable-gtktest
  make -j"$JOBS" && make install )
cd "ffmpeg-$FF_VER"
./configure "${FF_CROSS[@]}" --prefix="$PREFIX" \
  --pkg-config-flags=--static --extra-cflags="-I$PREFIX/include -Os" --extra-ldflags="-L$PREFIX/lib" \
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug \
  --disable-ffplay --disable-avdevice --disable-iconv --enable-small --enable-static --disable-shared \
  --enable-libmp3lame --enable-zlib \
  --enable-protocol=file,pipe \
  --enable-demuxer=mov,matroska,mp3,aac,ogg,wav,flac,ffmetadata,image2,image_jpeg_pipe,image_png_pipe,image_webp_pipe,concat \
  --enable-muxer=mp4,mov,ipod,mp3,matroska,webm,ogg,opus,image2,ffmetadata,adts,wav,null \
  --enable-decoder=aac,aac_latm,opus,vorbis,mp3,mp3float,flac,pcm_s16le,pcm_f32le,mjpeg,png,webp,bmp \
  --enable-encoder=libmp3lame,mjpeg,png,pcm_s16le \
  --enable-parser=aac,aac_latm,h264,hevc,vp8,vp9,av1,opus,vorbis,mjpeg,png,webp,mpegaudio,flac \
  --enable-bsf=mjpeg2jpeg,dump_extra,remove_extradata,setts,aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe,av1_frame_split,null \
  --enable-filter=aresample,aformat,anull,null,scale,format,copy,crop,pad,setsar,atrim,trim,volume,anullsrc \
  --enable-swscale --enable-swresample
make -j"$JOBS"
cp "ffmpeg$EXE" "ffprobe$EXE" "$OUT/"
if [ "$TARGET" = win64 ]; then x86_64-w64-mingw32-strip "$OUT"/*.exe; else strip "$OUT/ffmpeg" "$OUT/ffprobe" 2>/dev/null || true; fi
ls -la "$OUT"
