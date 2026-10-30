# 릴리즈 노트

버전 번호는 [Semantic Versioning](https://semver.org/lang/ko/)을 따릅니다.

## [1.0.1] - 2026-10-30

### 추가
- **esds(ES 디스크립터) 해석**: ES_Descriptor / DecoderConfigDescriptor / AudioSpecificConfig / SLConfig를 필드 단위로 표시하고, 코덱 문자열(예: `mp4a.40.2`)이 포함된 한 줄 요약 제공
  - HE-AAC / HE-AACv2(SBR·PS)의 확장 샘플레이트와 core AOT 표시
- **원시 페이로드로만 보이던 박스의 필드 디코딩**
  - 코덱 설정: `avcC`, `hvcC`, `av1C`, `vpcC`(코덱 문자열·프로파일·레벨 요약), `dOps`(Opus), `dac3`(AC-3), `dec3`(E-AC-3)
  - 샘플 엔트리 부가 정보: `btrt`, `pasp`, `colr`, `fiel`, `clap`
  - 테이블: `sdtp`, `stz2`, `sgpd`, `sbgp`
  - 프래그먼트: `tfhd`·`trun` 플래그별 전체 필드와 샘플 플래그 해석, `tfra`, `mfro`
  - 기타: `dref` 하위 `url `/`urn `, `ilst` 항목(`©too` 등)의 `data` 값, `mdat`/`free` 크기
  - `stsd`/`dref`/`meta` 컨테이너의 version/flags/entry_count 표시
- **트랙 종류 표시**: `trak` 라벨을 `트랙(컨테이너)` 대신 `트랙(비디오)`, `트랙(오디오)` 등으로 표시(`hdlr` handler_type 기준)
- 샘플 엔트리(`mp4a`, `avc1`, `hvc1` 등) 박스에 설명 라벨 추가

### 수정
- `stsd` 하위 샘플 엔트리(`mp4a`, `avc1` 등) 안의 자식 박스(`esds`, `avcC`, `btrt` 등)가 트리에 나타나지 않던 문제
  - 오디오 28바이트 / 비디오 78바이트 고정 필드를 건너뛰고 자식 박스를 파싱하도록 수정(QuickTime 사운드 디스크립션 v1/v2 포함)
  - 샘플 엔트리 고정 필드(channelcount, samplerate, width, height, compressorname 등)도 필드로 표시
- 특정 박스의 필드 디코딩이 실패해도 전체 파싱이 중단되지 않고 해당 박스에 `error` 필드로 표시

## [1.0.0] - 2026-10-30

첫 릴리즈.

### 주요 기능
- **컨테이너 구조 시각화**: MP4/MOV(ISO BMFF) 박스 트리와 필드별 `hex → 의미` 주석, Hex 덤프 하이라이트. MKV/WebM, FLV, MPEG-TS, HLS, GIF 파서 포함
- **소스 입력**: 로컬 파일 드래그&드롭 / 파일 선택 / URL 불러오기(최근 URL 기록 드롭다운)
- **서버 미디어 라이브러리**: 파일 업로드·목록·삭제 및 선택 분석, 최대 업로드 크기 환경변수 설정
- **비디오 재생**: 브라우저 재생(URL은 서버 프록시 경유), FLV 코덱 지원 및 재생기 종류 추정
- **ffprobe 분석**: `format` / `streams` 원본 JSON과 요약 카드
- **트랜스코딩 이상 점검 / 무결성 검사**: 해상도·픽셀 포맷·VFR·길이 불일치·faststart 등 점검, 컨테이너별 무결성 검사
- **진행률 표시**: 업로드, 탭 로딩, 파일 분석, 무결성 검사 진행률
- **보안·운영**: URL 불러오기 SSRF 방어, ffprobe/무결성 검사 로깅 및 로그 로테이션

[1.0.1]: https://github.com/flyforme2016/video-analyzer/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/flyforme2016/video-analyzer/releases/tag/1.0.0
