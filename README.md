# Video Analyzer

비디오 컨테이너의 **실제 바이트/박스 구조를 시각화**하고, **ffprobe 메타데이터**를 보여주며,
**트랜스코딩이 잘못된 부분이 없는지** 자동 점검하는 웹 기반 분석기입니다.

## 주요 기능

1. **바이트 / 박스 시각화 (ISO BMFF)**
   - MP4/MOV 계열 파일의 박스(atom) 트리를 재귀적으로 파싱
   - 박스를 클릭하면 필드별로 `실제 바이트(hex) → 의미` 를 표로 표시
     ```
     00 00 00 18    size = 24 bytes (크기)
     66 74 79 70    type = "ftyp"
     69 73 6f 6d    major_brand = isom
     00 00 02 00    minor_version = 512
     69 73 6f 6d    compatible_brand[0] = isom
     61 76 63 31    compatible_brand[1] = avc1
     ```
   - 오프셋·ASCII가 함께 보이는 Hex 덤프, 선택한 필드 영역 하이라이트
   - MP4가 아닌 컨테이너(예: GIF)는 원시 Hex로 폴백 표시

2. **소스 입력**: 로컬 파일 드래그&드롭 / 파일 선택 / URL 불러오기

3. **비디오 재생**: 입력 영상을 브라우저에서 바로 재생 (URL은 CORS 우회를 위해 서버 프록시 경유)

4. **ffprobe 분석**: `format` / `streams` 원본 JSON + 핵심 요약 카드

5. **트랜스코딩 이상 점검** (ffprobe + 박스 구조 종합)
   - 이미지 계열 코덱 오인식(예: GIF로 처리됨)
   - 홀수 해상도 / 비호환 픽셀 포맷(yuv420p 권장)
   - 가변 프레임레이트(VFR) 의심, 프레임 수 불일치
   - 컨테이너↔스트림 길이 불일치, 0이 아닌 시작 시간
   - `moov`/`mdat` 순서로 본 **faststart** 웹 최적화 여부

## 요구 사항

- Node.js >= 16
- `ffprobe` 설치 (PATH에 있거나 환경변수 `FFPROBE_PATH`로 지정)

## 설치 및 실행

```bash
npm install
npm start
# 브라우저에서 http://localhost:3000 접속
```

포트/ffprobe 경로 변경:

```bash
PORT=8080 FFPROBE_PATH=/usr/local/bin/ffprobe npm start
```

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/probe/file` | multipart(`video`) 업로드 → ffprobe JSON |
| POST | `/api/probe/url`  | `{ "url": "..." }` → ffprobe JSON |
| GET  | `/api/proxy?url=` | 원격 미디어 스트리밍 프록시(Range 지원) |
| GET  | `/api/health`     | 상태 확인 |

## 구조

```
server.js            Express 백엔드 (ffprobe 실행 / URL 프록시 / 파일 업로드)
public/
  index.html         UI
  styles.css         스타일
  app.js             프론트엔드 컨트롤러 (재생/파싱/표시/점검)
  mp4parser.js       ISO BMFF 박스 파서 + 필드 디코더
```

## 참고

- 대용량 파일은 박스 파싱 시 선두 일부(기본 256MB)만 읽습니다. `moov`가 파일 후미에 있고
  일부만 로드된 경우 점검에서 "moov 미확인"으로 표시될 수 있습니다.
- URL 분석 시 바이트는 프록시의 Range 요청으로 선두만 받아 파싱합니다.
