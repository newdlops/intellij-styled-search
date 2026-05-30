# zoek-rs Graph Index Optimization Log

대상 corpus: `/Users/lky/project/captain2/captain`
- files: 135,567
- symbols: 4,141,426
- ref_sites: 38,222,730
- references emitted: 14,372,638 (invariant — 모든 회귀 검증 기준)

목표: graph-rebuild total wall **10초 이내**
하드 제약: 프로세스 메모리 **≤ 16GB**
정확도 게이트: **75 lib tests 모두 통과**, references count 정확

---

## ▶ START HERE — 다음 세션 진입점 (W24 종료 시점)

**현재 상태**:
- **★ W24: B6 stage 1+2 — peak RSS 17.98→15.72GB(OV1 ON서 16GB 캡 아래 복귀!).** peak 측정으로 **OV1(wall −2.8s)이 +2GB로 캡 초과** 발견 → **stage1(`raw_text` 드롭) + stage2(`source_ref_id` String→u64; dedup relabel은 bijective라 invariant 보존)**로 −2.26GB 내려 **OV1 유지하면서 캡 내 복귀.** 둘 다 byte-identical(invariant **14,372,638** + bytes **3,788,145,402** 게이트 통과, 75/75). prereq(`serialize_reference_record` u64화) 완료. full-B6 stage-3~5(enclosing→u64, name/receiver→interner, Vec<RefSite> drop) 남음. → 상세 **`### 이번 세션 (W24)`** + full-B6 plan. 커밋 `5a944b9` + (이번 stage-2).

**full B6 (RefSite AoS retire) 진행 상황**:
- ✅ **prereq 완료**: `serialize_reference_record`가 source_ref_id를 **pre-parsed u64 + Option<&str> inline**로 받음(14M write path서 문자열 재구성 0, byte-identical). callers 2 갱신.
- ✅ **stage-1 완료(커밋 5a944b9)**: `raw_text` 드롭(−1.8GB data).
- ✅ **stage-2 완료(이번)**: `source_ref_id` String→u64. `stable_ref_id_u64`+`site_partial_hash_u64` 신규(string판 `edge_key_hash`/`site_partial_hash` 제거). site_cols build·phase_f가 u64 site_partial(**dedup relabel — bijective라 invariant 보존, 게이트 확인됨**). materialize=`format!` 복원(cold), serialize/parse_ref_site=u64 직접. **검증: 75/75 + invariant 14,372,638 + bytes 3,788,145,402 + peak RSS 17.98→15.72GB(OV1 ON서 16GB 캡 아래 복귀!).**
- **stage-3(다음, ~15곳 cascade — stage-2보다 큼) = `enclosing_symbol_id` Option<String>→u64**(−~0.6-0.8GB, dedup 무관이나 resolve-helper로 번짐). 얽힘 지점:
  - **fact-eq cross-struct (핵심)**: `type_fact_applies_by_enclosing`(7484: `fact.enclosing_symbol_id.as_deref() == site_enclosing_id`)·`resolve_type_fact_targets_by_key`(7492)·`compute_receiver_resolution`이 site enclosing을 `Option<&str>`로 받아 fact(String)와 비교 → site쪽 param을 `Option<u64>`로 바꾸고 fact쪽은 비교 시 parse(cold). helper 시그니처 + 호출부 cascade.
  - **enclosing_symbol_id_hash repurpose**: RefSite `enclosing_symbol_id: Option<String>` drop + `enclosing_symbol_id_hash`(skip, stable_hash(str)) → `enclosing_id: u64`(non-skip 직렬화, =parse_stable_symbol_id_to_u64, 0=None)로 repurpose. receiver_cache 키(6275/6346)가 (recv_hash, enclosing_id)로 **relabel**(bijective, invariant-safe). SiteCols.enclosing_symbol_id_hash→enclosing_id. FIXUP(1818) enclosing 재계산 제거(직렬화됨).
  - serialize_reference_record(10529, 14M write path) enclosing도 pre-parsed u64로(prereq 패턴). serialize_ref_site(11035)·parse_ref_site(11154) u64 직접. materialize(8629/8661) `sym:HEX16` 복원(cold).
  - 게이트: 75/75 + invariant 14,372,638 + bytes 3,788,145,402. fresh 세션 권장(resolve-helper cascade라 한 호흡에).
- **stage-4 = `name`/`receiver_name`→u32 name_id**(NameInterner + **reverse `Vec<Box<str>>` 추가**): resolve readers + ref_site write가 interner로 복원.
- **stage-5 = `Vec<RefSite>` drop**: 위 전부 columns화 후 resolve 진입 전 drop. **추가 −나머지 → peak 더↓.**
- 각 stage 게이트: 75/75 + invariant 14,372,638 + **bytes 3,788,145,402**(dedup/serialize divergence 포착). **stage-2 실증**: dedup relabel은 bijective면 invariant·bytes 둘 다 보존(게이트가 확인). OV1 ref_site write가 resolve 중이라 serialize도 columns화해야 최종 drop 가능.
- **W23: write 재프로파일(타겟 정정) + OV1 구현 — ref_site write를 resolve와 overlap.** index 병목은 reference가 아니라 **ref_site(38M) static write**(references는 이미 채널 overlap). ref_site write를 **resolve scope에 dedicated pool**(W1 패턴)로 spawn, `write_store`가 `skip_ref_sites`로 skip. **paired: index 6544→2802ms(−57%), total −2.8s, byte-identical, deadlock 없음 → default ON 승격**(opt-out `ZOEK_OVERLAP_STATIC_OFF`, channel pipeline서만 활성). default 재검증 14,372,638/3,788,145,402 ✓. **OV2(symbols/facts도 overlap) 시도→❌revert**: index 690ms(−85%)이나 resolve +2.1s contention으로 net −2.3s<OV1 −2.8s → OV1(ref_sites-only)이 sweet spot. 단 OV1 concurrency라 실사용 부하/incremental 추가 관찰 권장. → 상세 **`### 이번 세션 (W23)`**.
- **W22: phase_e 재프로파일 → 옵션 C 기각 + B6 범위 정정 (코드 변경 0, de-risking 조사).** phase_e 20.6s의 **~65%가 rayon oversubscription parking**(cvwait/semaphore가 `rayon Sleep`/`join_context`, **채널 backpressure 아님**), 실 compute 분산, 대형 맵 probe가 dominant 아님 → **옵션 C는 ❌C2 재현 위험이라 기각**. 사용자 재선택 **B6**. **B6 범위 좁힘**: 디스크 write(1957)가 resolve 전이라 **RefSite를 resolve 직전 drop**하면 −6GB, **디스크/incremental 경로 불변** → 변환은 resolve-time reader 3종(compute_receiver_resolution/phase_f/materialize)만. **⚠️ B6 prize=메모리 −6GB, phase_e wall 이득은 불확실**(hot path 이미 columns). → 상세 **`### 이번 세션 (W22)`**.
- **W21: parse 공략 — ⚠️ 옵션 A 전제 정정 + P1/P2.** **parse는 tree-sitter가 아니다 — 이미 hand-written regex/string 파서**(`build_file_graph`→`extract_*`, Cargo에 tree-sitter 의존성 없음). 그래서 "tree-sitter를 custom tokenizer로 교체"라는 옵션 A는 **무의미**; 진짜 공략 = 기존 추출 함수의 할당/스캔 최적화. **내장 `ZOEK_PARSE_PROFILE=1`이 parse를 8개 sub-phase로 분해**: ref_sites **46%** > symbol_defs **20%** > type_facts **18%** > import_facts 8% > materialize 7%. **P1**(extract_ref_sites 할당 감축)+**P2**(sanitize Cow). → 상세 아래 **`### 이번 세션 (W21)`**.
- **W20: B5 완료 + B3/B4/B5 default 승격** (column SoA가 default, opt-out `ZOEK_SOA_OFF`). prefilter −95% / phase_c −47% 확고, phase_e(B4) 부하서 −16%.
- **W19 B4 / W18 B2+B3 / W17 B1 / W16 channel ON** — 상세 각 섹션.
- 코드: W1~W21 모두 **uncommitted**. build green, **75/75 tests**, **invariant 14,372,638** + **bytes=3788145402**(P1+P2 모두), schemaVersion=20.

**W21 parse 측정 (matched-load paired + profile)**:
- **P1 (extract_ref_sites 할당)**: `uri` 제거(dead 필드 — 38M×~70자 할당, 미사용) + `rel_path`/`language`/`edge_kind`/`access_kind` → **`Arc<str>`**(per-file/정적 Arc, per-site refcount clone). matched-load paired: **ref_sites CPU −11.3%, parse wall −1.1s**(공유분만) + uri 제거(~−1s 추정) ≈ **parse −2s + 메모리 절감**(in-memory ref_sites 대폭↓).
- **P2 (sanitize Cow)**: `sanitize_code_line`/`sanitize_python_ref_site_code_line` → `Cow<str>`, quote/comment trigger 없는 clean 라인은 **borrow**(할당 0). sample #2 leaf(`sanitize_code_line` 34K) 공략.
- ⚠️ **버그 교훈**: P2 초기판이 invariant(14,372,638)는 통과했으나 **`bytes`가 119KB 달랐다**(P1=3788145402 vs 초기 P2=3788264475). 원인: owned sanitize가 `//`를 **언어 무관**하게 주석 처리하는데 python fast-path가 `/` trigger 누락 → python `a // b`(정수나눗셈) divergence. **invariant(ref count)만으로 부족 — `bytes`도 게이트에 추가**. 수정 후 bytes 복귀 확인.

**다음 작업 후보 (택1, 30s 목표까지 큰 레버 필요)**:
1. **parse 추가 공략**: 남은 hot = ref_sites/symbol_defs/type_facts의 **스캔**(sanitize/identifier_tokens/member_receiver/`StrSearcher`·`str::find` sample ~92K) + **file I/O**(open/read/close 135K 파일 ~86K) + **malloc 경합**(128스레드 `__ulock_wait` 39K). type_facts(18%)가 sparse한데 모든 라인 sanitize — fast pre-check로 skip 여지. 단 스캔/추출 변경은 정확도 위험(부분 정정한 옵션 A의 본질).
2. **index/write 공략 (옵션 D)**: stream_references + write_graph_shards(~20s). D1a(scratch 제거)/D1b(per-worker shard writer). 예상 −3~6s.
3. **B6 (RefSite cold-path retire)**: RefSite AoS 제거 → 메모리 −6GB+ + FIXUP 제거. wall 직접 win 작으나 토대.
4. **phase_e B4 추가 win**: 대형 맵 probe(`members_by_container_and_name_h` bucket-miss).

**진입 절차**:
1. 이 문서 **W21 + W20 섹션** 읽기. parse 구조: `build_file_graph`(graph.rs:3079) → `extract_symbol_defs`/`extract_import_facts`/`extract_type_facts`/`extract_ref_sites`. `ZOEK_PARSE_PROFILE=1`로 분해.
2. `cargo build --release` + `cargo test --release --lib` (75/75).
3. 위 후보 중 선택. (30s 목표는 멀티세션 — parse 스캔 + index가 남은 큰 덩어리.)

**게이트 (매 step 필수)**: `cargo test --release --lib` 75/75 + captain2 `referenceCount=14,372,638` **+ `bytes`(=3788145402, parse 변경 시 필수)** + schemaVersion=20.
**측정 주의 (W15+W20+W21 교훈)**: captain 종료해야 진짜 idle / 연속 측정 금지(128-worker가 load 누적, run 사이 load1<3 대기) / background는 절대경로 + foreground 장시간은 kill(137) 위험 → **background로** / **단일 wall 절대 신뢰 금물**(parse도 load 3→7서 13→21s 출렁; CPU-sum도 load 의존 → **matched-load paired만 신뢰**) / **parse 변경은 `bytes`까지 비교**(ref count는 divergence 못 잡음 — W21 버그).

---

## 현재 best state (W15 / W1+W2 multi-thread writer — channel net 동률 확인)

| 측정 | W12 best (idle) | W15 channel (W1+W2, 3-run paired) | W15 fallback (paired) | 비고 |
|---|---|---|---|---|
| **Total wall (best)** | 69.2s | **67.2s (R3)** | 68.9s (R2) | net 동률 |
| **Total wall (range)** | — | 67.2~79.0s | — | phase_e 노이즈 지배 |
| phase_e | 14.4s | 17.5~22.2s | 15.6s | captain python 31% 영향 (channel/fallback **공통**) |
| phase_f | 5.4s | 5.8~6.3s | 5.0s | 정상 (phase F는 buffered default) |
| index (symbol+count write) | — | **9.7~10.3s** | 21.3s | channel이 reference write overlap (−11s) |
| Disk (callgraph) | 4.7GB | 4.7GB | 4.7GB | same |

**핵심 결론** (W14 "net win 미달" 재확인 + 원인 규명):
- **W1+W2 writer는 정확·deadlock-free + single-thread writer 병목 해소.** invariant=14,372,638 (모든 run), 75/75 tests, schemaVersion=20. idle 67~69s로 W12 best(69.2s) 동급 — 회귀 없음.
- **channel pipeline net win ≈ 0.** index에서 reference write overlap으로 −11s 벌지만(channel 10s vs fallback 21s), channel은 phase F(전체의 64%, 9.18M records)를 resolve 끝에 writer가 drain하느라 그만큼 도로 씀. → total은 fallback과 동률.
- **측정 환경 한계 (이번 세션 최대 교훈)**: captain VSCode workspace의 python 14개가 ~31% CPU **상수** 점유 → phase_e가 15~22s 변동 (channel/fallback 공통 단계). total wall 노이즈의 주원인. **연속 측정 시 graph-rebuild 자체(128 worker)가 load avg를 누적**시켜 load 5→44로 보이게 함 — run 사이 idle 대기(load1<5)로 해소. 진짜 idle(captain 완전 종료) 측정은 미실시.
- **phase F overlap (W2 + flag)은 보류**: `ZOEK_LIGHT_CHANNEL_PHASE_F=1`로 phase F도 channel stream하면 backpressure 경계선(phase_f 6.4~14.3s 변동) + net 이득 미미 → flag **OFF default**. 코드는 실험용 보존.

**W1 (multi-thread writer, dedicated rayon pool)** — graph.rs:8503 `write_lights_from_channel`, 8391 `append_lights_to_both_shards`:
- writer가 dedicated `rayon::ThreadPoolBuilder` pool에서 `append_lights_to_both_shards` 호출 → global pool(phase E worker가 channel send block 중 점유)과 분리되어 **nested deadlock 없음** (W14 실패 회피).
- `append_lights_to_both_shards`: worker_count를 `rayon::current_num_threads()` 기준으로 (global 128 / dedicated 8), emitted count 반환 (invariant 정확).
- env: `ZOEK_LIGHT_WRITER_THREADS` (default min(cores,8) clamp 2..8), `ZOEK_LIGHT_WRITER_FLUSH` (default 512K records).

**W2 (recv/flush 분리, double-buffering)** — graph.rs:8503 `write_lights_from_channel`:
- writer를 **recv thread**(channel drain → buffer) + **flush thread**(shard writers + dedicated pool 소유, append_lights 실행)로 분리. `std::thread::scope` nested, bounded(3) flush queue.
- recv가 flush에 안 막혀 channel을 계속 비움 → W1의 "flush 중 recv 정지 → channel 참 → phase F worker stall" 해소.
- 효과: phase F overlap 시 phase_f가 W1(13.6s 일관 폭증) → W2(6.4s 회복 *가능*)로 개선되나, flush가 phase F 생성속도(1.5M rec/s)와 아슬아슬해 **간헐 폭증(14.3s) 잔존** → phase F overlap은 여전히 보류.

**~~미결정~~ → 해소 (W16)**: channel default = **ON 확정**. W16 paired 측정에서 보통 부하(load ~3.2)에 ON이 OFF보다 평균 14s 빠름 (idle net-0은 완전 idle 한정 artifact). 코드는 `ZOEK_DISABLE_LIGHT_CHANNEL=1`로 opt-out 유지. 상세는 W16 섹션.

---

## 이전 best state (W12 세션 후, 5-run 저전력 실측)

| 측정 | 원본 추정 | W11 best (pool sweep idle) | W12 best (5-run 저전력 idle) | Δ vs W11 baseline |
|---|---|---|---|---|
| **Total wall** | 100~118s | 64.2s (W=128) | **69.2s (Run 4, n=5)** | **+5.0s 회귀** ⚠️ |
| **phase_e** | ~30s | 13.8s | 14.4s | +0.6s (Stage 2/3 효과 불명확) |
| **parse** | — | 10.2s | 12.2s | +2.0s (partial_hash precompute가 38M 사이트에 추가 워크) |
| **phase_e_prefilter** | — | 2.0s | 1.1~1.4s | **−0.6~0.9s** ★ Stage 3 file-local 효과 명확 |
| **phase_c** | 6.5s | 4.2s | 3.6~4.0s | similar |
| **phase_f** | 11.7s | 4.5s | 4.9~5.4s | +0.4~0.9s |
| **stream_references** | — | 11.0s | 11.0~11.6s | similar |
| **write_graph_shards** | — | ~9.9s | ~11.1s | +1.2s (시스템 변동?) |
| **Disk (callgraph)** | 7.27GB | 4.7GB (W11) | 4.7GB | same |

5-run total (저전력 idle): 88.5 / 94.4 / 75.9 / **69.2** / 70.2s — 디스크 캐시 warm 후 안정화 ~69-70s.

**솔직한 진단**:
- Pool=128, Stage 1, Stage 2 (per-file receiver_cache), enum-ids precompute, Stage 3 (file-local 2-level views) 모두 의도된 효과는 작동 (`phase_e_prefilter` −0.6~0.9s 명확). 하지만 **`partial_hash` precompute가 net 음수**:
  - 원래 `site_partial_hash`는 phase_e에서 사이트당 candidate 있는 14M 번만 호출 → ~0.7s wall
  - W12에서 모든 38M ref_sites에 parse-time precompute → ~1.9s parse work 추가
  - 순 효과: **+1.2s 회귀**
- 다른 phase 회귀 (parse +2.0, phase_f +0.9, write_graph_shards +1.2)의 일부는 시스템 변동 (run-to-run 79~94s spread).

Sub-phase 분해 (W12 저전력 best 69.2s 기준, W=128):
- discover: 1.2s
- parse: 12.2s (tree-sitter, CPU-bound, **128 rayon workers**, W12 precompute로 약간 증가)
- resolve: 33.7s (phase_a 2.4 + phase_b 1.9 + phase_c 3.6 + phase_d 2.0 + prefilter 1.4 + site_lang_id 1.9 + phase_e 14.4 + phase_f 5.4)
- index: 22.2s (11.1s stream_references + ~11.1s write_graph_shards)

---

## 누적 적용된 변경 (모두 commit 후보)

### Resolve (phase E)
- `GraphSymbol.kind_flags: u8` 캐시 — string match 제거
- `GraphSymbol.language_id: u16` 캐시
- `GraphSymbol.id_u64: u64` 캐시 (parse_stable_symbol_id_to_u64 결과)
- `site_language_ids: Vec<u16>` precompute (prefilter + phase_e용)
- **Receiver memoization** (`(rel_path, receiver, enclosing_id)` → ReceiverResolution 캐시) — **가장 큰 단일 win, −8s on phase_e**
- Pointer-based sort/dedup (`&GraphSymbol`을 ptr cast로 비교, string compare 제거)
- `extend_and_collect_members_for_type` 단일 lookup 통합 (extend + collect가 같은 HashMap key 사용)
- `type_targets` 중복 dedup (sym ptr 기준)
- HashSet pre-sizing (rehash 회피)
- partial_hash + edge_key_from_partial_u64 (site-invariant prefix 공유)
- u64-keyed counts HashMap (per-worker; merge 시 id_to_string으로 변환)
- compute_native_counts no-op (zero-counts는 write 시 skip되므로 default 채우기 불필요)

### 직전 세션 (W1, W2, W2c, W5, W9a, W9b) — phase_e 공략

profiling-driven (macOS `sample` PID DURATION) 진단으로 새 hot path 식별 → 정확하게 공략.

- **W1 — dead materialize loop 삭제** (line ~5587)
  - phase_e worker boundary에서 `references = Vec::with_capacity(...)` 빌드 후 같은 이름의 빈 Vec로 즉시 shadow하던 dead code
  - sampling: 45K samples (~6% phase_e CPU) 절감
  - graph.rs phase_e worker close 부근

- **W2 — `rel_path_hash: u64` precompute** (`GraphSymbol`, `RefSite`에 #[serde(skip)] 필드 추가)
  - FNV-1a stable_hash로 parse 시점에 계산. ParseAccum 디스크 round-trip 시 load_from_file에서 fixup
  - hot loop의 `symbol.rel_path == site.rel_path.as_str()` (line 5461, 5542) → `rel_path_hash == rel_path_hash`
  - **sampling 검증**: memcmp 35.7K → 10.4K (−71%), memmove 28K → <1K (−97%)
  - **wall**: phase_e ~31s → ~25s (-19%)

- **W2c — `name_hash: u64` precompute** (동일 패턴, name 비교용)
  - line 5511의 `target.name == site.name.as_str()` → `name_hash` 비교
  - imported-candidate 루프 비용 절감. 단독 win은 noise 아래
  - W2와 같이 적용

- **W5 — `same_file_bare_count: AHashMap<(u64, u64), u32>` precompute** ★ 큰 win
  - phase_a에서 빌드: 1.5M (name_hash, rel_path_hash) → count
  - hot loop의 `fallback_candidates.iter().filter(...).count()` 패턴 (line 5495) → O(1) lookup
  - 일부 흔한 이름 ("log", "data" 등)이 1000+ candidates였던 worst case 제거
  - **sampling 검증**: closure leaf samples 402K → 163K (−59%)
  - **wall**: phase_e 25s → 15.6s (-38%)

- **W9a — receiver_cache key를 `(u64, u64, u64)` 로** (`RefSite`에 `receiver_name_hash`, `enclosing_symbol_id_hash` 추가)
  - cache key가 `(&str, &str, Option<&str>)` 3-string tuple → u64 triple
  - line 5363 receiver_cache.entry — 직전 #1 active hotspot (60K samples)
  - None은 sentinel 0 (collision risk u64-cubed로 negligible)
  - **sampling 검증**: closure leaf 163K → 94K (−42%), memcmp 11K → 5K (−55%)
  - **wall**: noise 내 측정 어려움 (1 run 기준 phase_e 15.6 → 17.1 추정 — system load 변동 폭이 더 큼)

- **W9b — `bare_symbols_by_name` key를 `u64` (name_hash) 로**
  - 직전 `&str` → `u64`. phase_e hot loop bare path + prefilter contains_key 둘 다 업데이트
  - 빌드는 phase_a에서 `symbol.name_hash` 사용
  - W9a와 같이 적용

### 이번 세션 (W12) — pool default 128 + Option C Stage 1 (file-bucket index)

**먼저 한 일**:
1. W11 baseline 재검증: 75/75 tests pass, references=14,372,638, schemaVersion=20 (stdout), callgraph 4.8GB. W11 D1c는 이미 자리잡음 (uncommitted, 사용자가 직접 커밋 예정).
2. **W11 D1c 효과 검증 profile**: stream_references isolated sample (18s window after phase_f probe).
   - `_platform_memmove`: W10 baseline 101K → **W11 31K (−69%)** ★ D1c byte-traffic 감소 명확히 입증
   - `__psynch_cvwait` 376K (변화 없음), 워커 60% idle 그대로
   - 새 #1 active CPU work: `serialize_reference_record` 39K + `serialize_ref_site_binary` 40K (이전 memmove에 가려있던 25 extend_from_slice 호출 + parse_stable_*_to_u64)
   - **결론**: D1a/D1b의 잠재 효과가 비례 감소 (−0.3s 미만). stream_references 추가 win room 작음.
3. **Pool size sweep** 진행 (`ZOEK_GRAPH_WORKERS` ∈ {15, 24, 32, 48, 64, 96, 128} 각 1 run, captain2):
   - 결과 위 "❌ W12-pool" 표 참조. **64 default 거의 optimal, 128 −1.7s noise envelope 내**. 물리(15)에서 가장 느림 → cvwait 60%는 OS oversubscription 아니라 **HashMap probe memory stall 자체**.
   - 부수적: 오늘 idle baseline **64-66s** (W11 doc 76.8s avg 보다 11s 빠름 — 이전 측정이 load-affected).
4. 진단 결과로 D1a/D1b 보류. phase_e (13.8s @ W=128)가 stream_references (11s)보다 큰 새 #1 phase → Option C Stage 1 진입.

**구현된 변경**:

- **W12-pool — `ZOEK_GRAPH_WORKERS` default 64 → 128** (graph.rs:83-94, 162-175)
  - 주석에 W12 pool sweep 결과 인용

- **W12-Stage 2 — per-file receiver_cache scope + key 축소** (graph.rs:5498, 5530-5534)
  - receiver_cache key `(u64, u64, u64)` (rel_path_hash 포함) → `(u64, u64)` (rel_path 제외)
  - bucket loop가 파일 경계 진입 시 cache.clear() — 현재 파일의 (receiver, enclosing) 만 보유
  - 캐시 작아짐 (per-file ~50-200 entries vs chunk-wide ~10K+) → 더 좋은 locality + 더 적은 rehash
  - Memory: 0 추가

- **W12 partial_hash precompute on RefSite** (graph.rs:727-733 struct, 4886-4923 build, 1681 fixup, 9988 binary parse, 5618 phase_e callsite)
  - `RefSite.partial_hash: u64` 신규 (#[serde(skip)])
  - `site_partial_hash(source_ref_id, edge_kind)`을 parse 시점에 1회 계산
  - phase_e 워커 hot loop의 `let site_partial = site_partial_hash(...)` (14.4M calls, profile 37K leaf samples = phase_e active CPU 5%)을 cached field read로 교체
  - Memory: +8B/site × 38M = ~304MB

- **W12-Stage 3 — file-local 2-level views + worker pre-screen** (graph.rs 여러 위치)
  - Phase B 끝에서 3개 2-level rebuild:
    - `import_targets_by_rel: AHashMap<&str, AHashMap<&str, &[&GraphSymbol]>>`
    - `import_facts_by_rel: AHashMap<&str, AHashSet<&str>>`
    - `type_facts_by_rel: AHashMap<&str, AHashSet<&str>>`
  - **phase_e_prefilter**: per-worker rel_path 캐싱 (3개 view). 31M 사이트 × (rel_path, name) 튜플 hash → name-only inner probe로 단축. 캐시 hit rate ~99% (ref_sites가 parse-chunk file-grouped).
  - **phase_e 워커**: bucket 전이 시 3개 file-local view refresh + bare path이 `current_file_imports`로 단축. 추가로 **receiver_cache miss pre-screen** — `compute_receiver_resolution`을 호출하기 전 file-local sets로 has_any 등가 검사. 매치 없으면 빈 ReceiverResolution을 캐시하고 비싼 함수 호출 자체 skip. profile에서 hash_one (4 variants 합 118K = phase_e active CPU 16%) 의 대부분이 (rel_path, name) 튜플 해시였음.
  - Memory: 3 outer maps × ~135K entries + small inner maps ≈ ~50MB peak. signature cascade 없음 — `compute_receiver_resolution` 시그니처 unchanged.

- **W12 access_kind_id + edge_kind_id precompute on RefSite** (struct, build, fixup, binary parse 동일 위치 + 5384/5396/5550/5551 phase_e prefilter & worker + 7001-7048 phase_c + 8038/8248 stream_refs writers + 9888-9893 serialize_ref_site_binary)
  - `RefSite.access_kind_id: u8`, `RefSite.edge_kind_id: u8` 신규 (#[serde(skip)])
  - 새 상수 `ACCESS_KIND_BARE=0`, `ACCESS_KIND_MEMBER=1`, `EDGE_KIND_USAGE=0`/`CALL=1`/`CONSTRUCT=2` 추가
  - phase_e_prefilter (31M sites × 2 string compares) + phase_e worker (16M × 2) + phase_c chunk loop (38M × 2) + append_lights_to_both_shards (14M `matches!(edge_kind, "call"|"construct")`) + write_lights_from_channel (14M) + serialize_ref_site_binary (`compute_*_id` call) 모두 정수 비교로
  - profile의 `_platform_memcmp` 42K samples (phase_e active CPU 6%) + 비슷한 phase_c 비중 절감 기대
  - Memory: +2B/site × 38M = 76MB

  - `apply_rayon_pool_size`, `graph_worker_count` 두 곳 default 변경 (=`MAX_GRAPH_WORKERS`)
  - 주석에 W12 pool sweep 결과 인용

- **W12-Stage 1 — `PhaseEFileBucket` 도입 (Option C 토대)** (graph.rs:5078~5125 신규 + 5419~ 수정)
  - 신규 구조체 `PhaseEFileBucket { rel_path_hash: u64, indices: Vec<u32> }`
  - 신규 helper `build_phase_e_file_buckets(ref_sites, phase_e_indices_effective)` — O(N) 선형 스캔. ref_sites가 파일 단위 group된 상태 (FileGraph ingest 원자성) 이용해 인접 rel_path_hash 같으면 같은 bucket에 push, 바뀌면 새 bucket 시작.
  - phase_e 진입부 (graph.rs:~5424) — `t_e` 직후 buckets 빌드 + probe (`phase_e_buckets=N avg_sites/bucket=M`)
  - `process_chunk` 시그니처 `(start, end, worker_id)` → `(buckets_slice, worker_id)`
  - `chunk_estimate` 계산을 `(end-start)/3` → `buckets_slice.iter().map(|b| b.indices.len()).sum::<usize>() / 3` 으로 변경
  - 워커 inner loop `for pos in start..end { let site_idx = match phase_e_indices_effective {...}; ... }` → `for site_idx in buckets_slice.iter().flat_map(|b| b.indices.iter().copied()) { ... }` (flat_map으로 indent 변경 최소화)
  - rayon dispatch — range-based → bucket-range-based partitioning. 각 chunk는 contiguous bucket run, 누적 site count가 chunk_target_sites 도달 시 새 chunk 시작 → 파일 경계 유지하면서 work-stealing 균형.
  - **메모리**: bucket Vec<u32> 인덱스 ~16M × 4B + Vec overhead ≈ 70MB peak (16GB 한계 내 negligible)

**검증**:
- 75/75 lib tests pass
- references=14,372,638 invariant 유지 (4+ runs)
- phase_e_buckets=**129,762** (captain2 135,567 files 중 phase E 대상이고 hash 충돌 일부 fold 시 sensible), avg_sites/bucket=**241**
- schemaVersion=20 ✓

**Stage 1 wall delta**:
- 시스템 load 변동 (저전력 모드 토글 + 백그라운드 작업)로 wall 비교 불가능. baseline 64-66s (저전력 모드) vs Stage 1 후 84-114s (정상 모드 + load).
- 의도된 0 wall delta refactor — Stages 2-4 (per-file receiver cache, per-file local 6 sub-maps, per-file mini-context)의 토대.
- 진짜 win은 Stage 3+ (예상 phase_e −2~5s).

**W12 후 추가 진단 후보** (다음 세션 권장):
- Stage 2 — `compute_receiver_resolution` 결과를 bucket 시작 시 미리 일괄 빌드. W9a의 chunk-scope `receiver_cache` 대체. 예상 −0.5~1.5s. 안전 (시그니처 unchanged).
- Stage 3 — `import_targets`/`import_facts_by_file_local`/`type_facts_by_file_local`/`function_return_facts_by_file_name`/`star_import_facts_by_file`/`symbols_by_file_and_name` 6개 map의 per-file local view를 bucket prelude로 빌드. `compute_receiver_resolution`/`expand_receiver_for_name` 시그니처 cascade. 예상 −2~4s. 본 win.
- Stage 4 — members_by_container_and_name 진짜 mini-context. 이전 C2 시도 패턴 닮음 (실패한 attempt) — Stages 1-3 결합 시에만 win 보임. side-by-side validation 필요. 예상 −2~5s.

---

### 이번 세션 (W13) — F1.a: phase F의 rescan 루프 제거 (옵션 1 / Parse-Resolve fusion 첫 단계)

**먼저 한 일**:
1. optimization.md 읽고 W12 누적 상태 확인. **30s 목표 달성**을 위해 점진적 W-step (각각 −1~3s)로는 −40s 불가능 → 아키텍처 변경 필요. 4개 카드 도출:
   1. Parse-Resolve 융합 (−15~20s 가능)
   2. mmap 직접 출력 (−10~15s)
   3. tree-sitter lex-only fast path (−7~9s)
   4. Persistent index + delta rebuild
2. 사용자 선택: 옵션 1부터 진행, 나머지는 다음 세션.
3. 옵션 1 코드 매핑:
   - Phase A/B/C/D는 글로벌 패스 필요 (decompose 어려움)
   - Phase E 워커는 file-bucket 단위 (Stage 1 완료)
   - **Phase F의 입력 `light_in_for_tally: &[LightRef]`이 read-only 단일 사용처** (7204-7210의 14M-entry rescan으로 `reference_counts_by_symbol_id` 빌드)
   - F의 출력 `light_out`은 별도 Vec → 코멘트 명시: "rebuild_graph_native이 light_in_for_tally를 shards에 동시에 쓰도록 phase F가 light_out에 append하는 구조" (7196-7197)
4. **graph.rs:8298 `write_lights_from_channel`** 발견 (#[allow(dead_code)], Phase 5-A 명시) — Option 1 channel-driven write 파이프라인 토대가 이미 짜여있음, wiring만 안 됨.

**옵션 1 단계 분해**:
- **F1.a** — phase E 워커에서 slim tally 빌드 → F가 rescan 대신 직접 사용. 구조적 사전작업, 측정 가능한 −1s. **(이번 세션)**
- **F1.b** — phase E 워커가 LightRef를 channel로 send + writer thread (`write_lights_from_channel` wire-in) → stream_references와 phase_e의 wall 11s overlap. 예상 −5~10s.
- **F1.c** — parse → resolve 파이프라이닝. parse 12.2s를 resolve와 overlap. 예상 −5~8s.

**구현된 변경 (F1.a)**:

- **`push_light_resolved_reference` 시그니처 확장** (graph.rs:7534)
  - 새 파라미터 `target_tally: Option<&mut AHashMap<u64, usize>>`
  - 성공적 push (dedup 통과) 시 `tally[target.id_u64] += 1`
  - E의 5개 call site (5769/5795/5859/5886/5933): `Some(&mut local_target_tally)` 전달
  - F의 1개 call site (7378, token-shape addition): `None` (F는 tally 안 건드림)

- **`ResolveIntermediate.light_target_count_by_id_u64` 필드 추가** (graph.rs:813)
  - `AHashMap<u64, usize>` — phase E 워커들이 누적한 (target.id_u64 → count) merge 결과

- **E 워커 changes** (graph.rs:5524~5944)
  - 워커 로컬 `local_target_tally: AHashMap<u64, usize>` 추가
  - 워커 output tuple 8-element로 확장 (마지막에 tally)
  - 메인 thread merge 루프에서 `for (k, v) in w_tally: *light_target_count_by_id_u64.entry(k).or_default() += v;`

- **`apply_token_shape_likely_count_baseline` 시그니처 변경** (graph.rs:7206)
  - `light_in_for_tally: &[LightRef]` → `light_target_count_by_id_u64: &AHashMap<u64, usize>`
  - **7204-7210의 14M-entry rescan 루프 삭제**
  - 7361의 lookup `symbol.id.as_str()` → `&symbol.id_u64`

- **3개 caller wiring** (incremental update 2339, full rebuild 4997, rebuild 5060):
  - `&light_in` → `&intermediate.light_target_count_by_id_u64`
  - take/restore dance는 그대로 (light_in이 light_references로 복원되어 무해)

**검증**:
- 75/75 lib tests pass
- captain2 references=14,372,638 (3/3 runs)
- schemaVersion=20

**측정 wall (3 runs, 정상 모드)**:
- 위 best state 표 참조. phase_f 4.3~5.4s (vs baseline 6.0s) → 평균 −1.0s
- 다른 phase는 noise envelope 내. total wall 변화 없음 (best run 73.6s ≈ baseline 73.0s)

**F1.a 솔직한 진단**:
- 측정 가능한 wall win은 phase_f −1s (의도된 효과)
- 진짜 가치는 **F가 lights에 의존하지 않게 된 것** — F1.b에서 lights를 channel로 흘릴 때 F가 그대로 작동
- E 워커당 추가 cost: 14M pushes × AHashMap entry probe (~50ns) ≈ +0.7s — phase_e가 +0~4s noise 내인 이유의 일부 (남는 부분은 진짜 noise)
- 메모리: AHashMap<u64, usize> 약 3M unique targets × ~24B = ~72MB (16GB 한계 내 negligible)

**다음 세션 F1.b 진입 가이드**:
- `write_lights_from_channel` (graph.rs:8298)이 이미 짜여있음 — `crossbeam_channel::Receiver<LightRef>` 소비, scratch buffer 1개로 per-record serialize, per-shard writer로 직접 write
- 추가 필요: phase E rayon dispatch가 channel sender를 들고 있게 변경. light_refs Vec 누적 대신 send. spill 로직 제거.
- writer thread 1개 spawn (`std::thread::spawn` + `crossbeam_channel::bounded(10_000)`)
- `append_lights_to_both_shards` (8185) → `write_lights_from_channel` (8298)로 replace (rebuild path만, test/legacy는 그대로)
- F도 channel sender로 (light_out_f Vec 대신)

---

### 이번 세션 (W14) — F1.b: channel-driven write pipeline (단일 writer thread 한계 노출)

**먼저 한 일**:
1. optimization.md 읽고 W13 F1.a 상태 확인. 다음 카드 = F1.b. 4 cards 중 옵션 1 (Parse-Resolve fusion) 진행 중.
2. baseline 재측정 (정상 모드 3 runs, 시스템 load 무거움): total 82.8 / 108.1 / 120.6s — best 82.8s (Run 3). phase_e=18.7~27.6s, phase_f=4.7~8.9s, stream_references=16.1~26.7s. invariant=14,372,638 ✓
3. 토대 확인: `write_lights_from_channel` (graph.rs:8298) dead code 상태로 짜여있음, `crossbeam_channel` 의존성 OK, std::thread::scope 사용 가능, file_table은 ref_sites + symbols + facts에서 빌드 가능 (resolution.references 의존 없음 — captain2 light_stream path).

**옵션 1 단계 분해 갱신**:
- F1.a ✅ — phase F의 tally rescan 제거. W13에서 완료.
- **F1.b** — phase E worker가 LightRef batch를 channel로 send + writer thread (overlap). **(이번 세션 — 구조 완성, 단일 writer thread bottleneck으로 net win 미달)**
- F1.c — parse → resolve 파이프라이닝. parse 12.2s를 resolve와 overlap. 다음 세션.

**구현된 변경 (F1.b)**:

- **`push_light_resolved_reference` 시그니처 확장** (graph.rs:7574)
  - 새 파라미터 `flush_sender: Option<&crossbeam_channel::Sender<Vec<LightRef>>>`
  - push 성공 후 `refs.len() >= LIGHT_BATCH_FLUSH_SIZE (=4096)` 도달 시 batch를 channel로 송신 + 새 Vec로 교체
  - 6 callsites 업데이트: E 5개 (5783/5810/5875/5903/5951) + F 1개 (7411)

- **`LIGHT_BATCH_FLUSH_SIZE = 4096` 상수** (graph.rs:7616)
  - 4096 × 24B = 96KB per batch. 14M records → ~3.5K send 호출. record당 send overhead amortize.

- **`resolve_ref_sites_a_to_e` 시그니처 확장** (graph.rs:5156)
  - `light_sender: Option<&'a Sender<Vec<LightRef>>>` 추가
  - 3 callers (incremental update 2308, test/legacy 4961, rebuild 5028) → 모두 None pass-through 또는 Some로 wire-in
  - worker process_chunk closure 끝에 final flush: `if let Some(s) = light_sender { if !light_refs.is_empty() { s.send(take(&mut light_refs)); } }`

- **`apply_token_shape_likely_count_baseline` 시그니처 확장** (graph.rs:7235)
  - 동일 `light_sender` 매개변수. **단 rebuild path에서는 None 전달** (phase F는 채널 안 씀, backpressure 회피 — 아래 진단 참조). worker 끝 final flush도 무해하게 그대로 추가.

- **`resolve_ref_sites_for_rebuild` 시그니처 확장** (graph.rs:5020)
  - pass-through `light_sender: Option<&Sender<Vec<LightRef>>>`
  - `resolve_ref_sites_a_to_e`에 sender 전달 (phase E worker가 channel send)
  - `apply_token_shape_likely_count_baseline`에는 **None** 전달 (phase F는 Vec 누적; 위 진단)
  - phase F가 끝나면 `intermediate.light_references` = phase F의 9.2M records (Vec)

- **`rebuild_graph_native` channel pipeline wiring** (graph.rs:1998~2110 전체 재구조)
  - `use_channel_pipeline` 분기 — `ZOEK_DISABLE_LIGHT_CHANNEL` env로 opt-out 가능 (default ON)
  - **resolve 전 prep**:
    1. file_table을 ref_sites + symbols + facts에서 build (references 의존 없음 — light_stream path 가정)
    2. `write_file_table_binary` + `clear_graph_shard_families`
    3. target_shards + enclosing_shards open (`open_graph_shard_writers`)
  - **channel + scope**:
    - `crossbeam_channel::bounded::<Vec<LightRef>>(channel_cap)` — `ZOEK_LIGHT_CHANNEL_CAP` env (default 1024 batches = 4M records buffer ≈ 96MB)
    - `std::thread::scope`에서 writer thread spawn (`write_lights_from_channel`)
    - 메인 thread는 `resolve_ref_sites_for_rebuild(..., Some(&tx))`
    - resolve 끝난 후 메인이 phase F의 light_out 9.2M records를 **단일 거대 batch**로 channel send (`tx.send(std::mem::take(&mut resolution.light_references))`)
    - `drop(tx)` → channel close → `writer_handle.join()`로 reference count 받음
    - `finish_graph_shard_writers` (target + enclosing)
  - fallback path: 기존 stream_lights_to_sidecars / stream_references_to_sidecars 그대로 유지

- **`write_lights_from_channel` 시그니처 변경** (graph.rs:8317)
  - `Receiver<LightRef>` → `Receiver<Vec<LightRef>>` (batch granularity)
  - `#[allow(dead_code)]` 제거 (wired-in)
  - inner loop: `while let Ok(batch) = rx.recv() { for light in &batch { ... } }`
  - 첫 시도(`append_lights_to_both_shards` fan-out) → **rayon nested pool deadlock** (4분 0% CPU 상태). 원인: phase E 워커가 channel send block 중 rayon pool 점유 → writer thread가 par_iter spawn 시 worker 못 얻음 → 양방향 wait. → **sequential per-record inner loop으로 회피**.

**검증**:
- 75/75 lib tests pass ✓
- captain2 references=14,372,638 (4+ runs, channel & fallback 모두) ✓
- schemaVersion=20 ✓
- deadlock 회복 후 모든 runs 정상 완료

**측정 wall (paired channel/fallback, 시스템 load 중간~heavy, 동일 환경 보장 불가)**:

| Run | path | total | resolve | phase_e | phase_f |
|---|---|---|---|---|---|
| Channel A | channel | 96.9s | 69.8s | (load) | 8.8s |
| Fallback A | fallback | 93.2s | 46.0s | (load) | 7.8s |
| Channel B | channel | 87.0s | 62.8s | (load) | 8.2s |
| Fallback B | fallback | 74.2s | 36.7s | (load) | 5.8s |

**솔직한 진단** (이번 세션의 핵심 학습):
- **현 형태에서는 channel pipeline이 fallback보다 4~13s 느림** (위 4 runs, load 변동 envelope 큼)
- 원인: **single-thread writer가 multi-thread baseline writer보다 throughput 낮음**
  - sequential writer: ~750K records/s × 14M records = ~19s drain
  - baseline `stream_lights_to_sidecars` → `append_lights_to_both_shards`: rayon par_chunks + par_iter_mut → 11~16s for same workload (idle)
  - phase E (18s) 동안 writer가 5M records 처리 + phase F 끝난 후 9M records drain — overlap이 single-thread writer 추가시간을 못 상쇄
- backpressure 진단: 처음 phase F도 channel send 시 backpressure로 phase_f wall이 4.7→17.6s 폭증. **phase F를 Vec 누적 + 메인이 한 batch send로 회피** (현재 구현). 이후 phase_f는 5~8s로 회복.
- 1차 시도 (writer fan-out via `append_lights_to_both_shards`) → **rayon nested deadlock**. 4분 동안 process 0% CPU. → sequential writer로 회피
- 메모리: peak ~336MB additional (channel queue + phase F lights), 16GB cap 안전

**구조적 가치 (코드는 그대로 유지)**:
- `write_lights_from_channel` + channel + thread::scope + sender hook은 미래 multi-thread writer의 토대
- Phase E worker가 LightRef Vec를 누적하지 않는 path 존재 — 메모리 절약 (단일 worker peak ~96KB batch만)
- phase F의 light_out → 한 batch send pattern은 backpressure 회피 reference

**왜 net win 안 나오는지 — bottleneck 정량 분석**:
- 이상적 채널 pipeline (idle): phase_e+f sequential 23s + writer parallel(11s) overlap → max(23, drain_residual) ≈ 23s + 1~3s = **24~26s** for resolve+stream 합
- 측정된 현실: single writer가 14M records를 19s drain → phase_e와 5M overlap, phase_e 끝 시점 backlog 9M → writer 추가 13s drain → resolve+stream 합 = 18 + 5 + 13 = 36s
- baseline sequential: phase_a..f sum 38s + stream_refs 11~16s = 49~54s
- **win 가능성 (이론)**: 49 - 36 = 13s (single writer 한계 가정)
- **win 실현 (multi-thread writer)**: writer drain 11s → resolve+stream = 18 + 5 + 5 (residual) = 28s → win 20s+

**다음 세션 진입 가이드 (F1.b 후속 + F1.c)**:

**Priority 0** — Idle 측정으로 현 F1.b 진짜 효과 확인:
- `ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain` (저전력 모드, 3+ runs)
- `ZOEK_DISABLE_LIGHT_CHANNEL=1 ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain` (동일 환경 fallback)
- 비교가 명확하지 않으면 channel default OFF (또는 코드 revert)

**Priority 1** — Writer multi-thread화:
- 옵션 W1: 별도 `rayon::ThreadPoolBuilder::new().num_threads(8).build()` writer 전용 pool. nested deadlock 회피하며 `append_lights_to_both_shards` 사용 가능. install_scope() 안에서 호출. 예상 −10~15s.
- 옵션 W2: writer thread를 2개로 분할 (target + enclosing 각각). LightRef를 두 channel에 split-send. 한 writer = 7M records / 750K/s = 9s. 단순한 변경. 메모리 +24B/record (channel 2배).
- 옵션 W3: writer 안에서 manual thread pool (std::thread::spawn N개). batch 받아 round-robin 분배.

**Priority 2** — F1.c parse → resolve 파이프라이닝:
- parse 워커 chunk 완료 → 즉시 phase_a/b 누적기에 incremental insert (channel 또는 lock-free counter)
- phase_a/b가 parse-end 후 0초로 단축 (이미 누적됨)
- 예상 −2~4s

**Priority 3** — 다른 비용:
- write_graph_shards (~8s, fallback path) 또는 stream_lights 11~16s — multi-thread writer로 흡수되면 충분

**환경 변수 정리** (현재 코드, W15 갱신):
- `ZOEK_DISABLE_LIGHT_CHANNEL=1`: fallback path 강제 (channel pipeline 우회). 디버깅 + idle 비교용
- `ZOEK_LIGHT_CHANNEL_CAP=N`: bounded channel batch capacity (default 1024)
- `ZOEK_LIGHT_WRITER_THREADS=N`: W1 writer dedicated rayon pool 스레드 수 (default min(cores,8) clamp 2..8)
- `ZOEK_LIGHT_WRITER_FLUSH=N`: W2 writer flush threshold records (default 512K)
- `ZOEK_LIGHT_CHANNEL_PHASE_F=1`: phase F도 channel stream (overlap 실험, default OFF — backpressure 경계선)
- `ZOEK_RESOLVE_PROBE=1`: phase 별 wall + `(channel pipeline)` 마커 출력
- `ZOEK_SOA_B1=1` (W17): 옵션 B B1 측정 블록 — `[soa-b1]` 라인으로 interner build / column populate 비용 출력. **gated, normal run 무영향** (아직 미소비).
- ~~`ZOEK_SOA_B3=1`/`ZOEK_SOA_B4=1`/`ZOEK_SOA_B5=1`~~ → **W20에서 default ON 승격, 단일 opt-out `ZOEK_SOA_OFF`로 통합**: B3(prefilter, −95%) + B4(worker, 부하서 −16%) + B5(phase_c, −47%) 모두 column이 기본. `ZOEK_SOA_OFF=1` = 전 struct 경로(paired 측정/디버깅용).

**revert 절차 (사용자가 옵션 채택 시)**:
- graph.rs:7574 push_light_resolved_reference의 `flush_sender` 매개변수 제거 + 6 callsites에서 해당 인자 제거
- graph.rs:5156 resolve_ref_sites_a_to_e의 `light_sender` 매개변수 제거 + 3 callsites + worker final flush 제거
- graph.rs:7235 apply_token_shape_likely_count_baseline의 `light_sender` 매개변수 제거 + 3 callsites + worker final flush 제거
- graph.rs:5020 resolve_ref_sites_for_rebuild의 `light_sender` 매개변수 제거 + 호출 측 (line 2007 부근) 인자 제거
- graph.rs:1998~2110 rebuild_graph_native의 channel pipeline 분기 제거 — 원래 (W13 F1.a) 흐름으로 복원
- graph.rs:8317 write_lights_from_channel signature 원복 + `#[allow(dead_code)]` 복귀

(전체 변경 +~250 lines, revert 가능. W13 F1.a의 tally Hook은 그대로 유지하는 것이 안전 — 그건 net win이었음.)

---

### 이번 세션 (W16) — 현재 상태 fresh profile + phase_e file-local view u64 rekey

**먼저 한 일**:
1. optimization.md(W15까지) 읽고 75/75 tests + invariant=14,372,638 재확인. W1~W15 모두 uncommitted (graph.rs +1288 lines).
2. **마지막 phase_e profile이 W9 시점**이라 W10~W15 누적 후 hot path가 바뀌었을 것 → fresh profile (profiling build, channel ON, 20s window after phase_e_prefilter).
3. **측정 환경**: 측정 시작 시 `django-erd-ogdf-layout` 100% CPU + captain python ~15% (load1 5.1) → wall 부풀려짐(phase_e 34.7s). profile은 active-CPU만 봐서 robust.

**fresh profile 결과 (channel ON, load 무거움)**:
- phase_e가 resolve 75s 중 **34.7s로 압도적 #1** (load 보정해도 #1 확정 — W12 doc의 phase_e priority 1 재확인).
- **hot line #1 = graph.rs:6124 `s.send(batch)` (262K samples)** — channel send. 워커가 backpressure로 park (leaf의 cvwait 387K + semaphore_wait 271K가 여기 귀속). **부하 환경에서 channel pipeline이 phase_e를 직접 늘림** (idle net-0이지만 부하에서는 음수 — W15 "net 동률"은 idle 한정).
- active-CPU named cost: worker closure 360K > **hash_one 4종 합 80.6K** > memcmp 33K > site_partial_hash 20.9K > string reverse-search(memrchr+CharSearcher) ~24K.
- worker hot line: 5798(receiver_cache pre-screen, 92K), 5775(file 전환+rel_path probe, 53K), 5848(fallback_buf.extend, 50K), 5838(expand_receiver, 45K), 5855(bare imported lookup).
- **확인**: `partial_hash` precompute 필드는 이미 제거됨(호출만 잔존) — W12 "미해결 회귀"는 이미 revert 상태. site_partial_hash(20K)는 진짜 비용이나 정수화하려면 38M parse-precompute 필요(같은 함정) → 보류.

**구현된 변경 (W16 — file-local view inner map `&str` → `u64` rekey)**:
- W12-Stage 3의 3개 file-local view inner key를 precompute된 hash로 교체 (graph.rs:5394~5423 build):
  - `import_targets_by_rel: AHashMap<&str, AHashMap<u64, &[&GraphSymbol]>>` (inner key = `stable_hash(name)`)
  - `import_facts_by_rel: AHashMap<&str, AHashSet<u64>>`
  - `type_facts_by_rel: AHashMap<&str, AHashSet<u64>>`
- 빌드는 (rel_path, name) 엔트리당 `stable_hash(nm)` 1회 (phase_b only, ~few M × FNV ≈ 무시 가능).
- **prefilter probe** (graph.rs:5605~5624): receiver probe → `site.receiver_name_hash`, name probe → `site.name_hash`.
- **worker probe** (receiver pre-screen 5807~5814 → `site.receiver_name_hash`; bare imported lookup 5855 `m.get(&site.name_hash)`).
- 패턴 출처: `bare_symbols_by_name`(W9b)와 동일. 31M(prefilter)+16M(worker) 사이트의 per-site 문자열 해시/비교를 u64로.
- **collision 안전성**: per-file inner map은 ~10-100 names, 64-bit hash → collision prob negligible. W9b(1.5M names, name_hash keyed)에서 invariant 유지로 입증됨.

**검증**:
- 75/75 lib tests pass ✓
- captain2 references=**14,372,638** invariant 유지 (channel/fallback 양쪽, 3 runs) ✓ — collision 없음
- schemaVersion=20 ✓
- 컴파일 클린

**W16 솔직한 진단**:
- **정확한 wall delta 측정 불가** — before-profile(django 100% load)과 after-profile(quiet load)의 active-CPU 표본 총량이 달라 절대 비교 불가. paired idle 측정은 W1~W15가 uncommitted라 W16만 isolate 불가능 (git stash는 W1~W15도 revert).
- **win은 modest로 예상**: 핵심 깨달음 — **짧은 이름(method name 3~10자)의 AHash는 u64 해시보다 그리 안 비쌈** (AHash는 8B chunk 단위). u64 rekey의 진짜 이득은 hash보다 **probe hit/collision 시 memcmp → u64 단일 비교** 쪽. W2/W5/W9의 큰 win은 긴 문자열(rel_path 50+자)이나 worst-case 1000+ candidate에서 나왔음.
- 그래도 안전(invariant 보존) + 검증된 패턴 + 0 메모리 추가라 **유지**. hash_one 80K(active CPU ~10%)의 일부를 줄이는 방향은 맞음.

**이번 세션 핵심 결론 (전략)**:
- **incremental phase_e 문자열-해시 미세조정은 −1~3s에 그침** (W16 포함) → doc가 줄곧 경고한 "점진적 W-step으로는 10s 불가" 재확인.
- phase_e는 **memory-stall bound** (cvwait 60%, RefSite struct cold-load). 진짜 −10s는 **옵션 B (RefSite full SoA + interning)** — dense u32/u16/u8 columns로 L1/L2 친화 + 메모리 −92%. 3~5주, 큰 cascade.
- **channel default 결정 = ON 유지 확정** (priority 0 해소): paired ON/OFF ×2 (interleaved, load ~3.2, invariant 4/4 통과):

  | path | total (2 runs) | resolve | index |
  |---|---|---|---|
  | **ON (channel)** | **79.6 / 83.8s** (avg 81.7) | 54.6 / 58.0 | **10.9 / 11.4** |
  | OFF (fallback) | 91.0 / 100.1s (avg 95.6) | 48.3 / 55.8 | 28.8 / 30.2 |

  - **channel ON이 평균 14s 빠름** (두 ON run 모두 두 OFF run보다 빠름 — 일관). 부하에서 write(~18s)를 resolve overlap으로 숨기고 resolve는 +6-9s만 추가.
  - W15 doc의 "net 동률"은 **완전 idle 한정** artifact. 실사용(captain 상시 켜짐 = 항상 약간의 부하)에선 channel ON이 명확히 유리. **default ON 유지** (`ZOEK_DISABLE_LIGHT_CHANNEL=1` opt-out 보존).
  - 단, **django-erd 100% CPU 같은 극단 부하**에서는 send backpressure로 phase_e가 늘 수 있음 (첫 profile에서 6124 send 262K park 관측). 그 영역은 outlier — 보통 부하에선 무관.

---

### 이번 세션 (W18) — B2+B3: `SiteCols` 도입 + column-only prefilter (★ SoA 가설 검증)

**먼저 한 일**:
1. optimization.md(W17까지) 읽고 75/75 + invariant=14,372,638 재확인. W1~W16+B1 모두 uncommitted.
2. **B1 통찰 두 개를 동시에 만족하는 경로 설계**: (a) "별도 38M scan 말고 site 순회 pass에서 build" — 이미 존재하는 `site_language_ids` par_iter(prefilter 직전, AoS traversal 이미 지불 중)를 **확장**. (b) "half-measure 금지(문자열 남기면 효과 0)" — prefilter는 문자열 없이 hash로 productive 판정 가능하므로 **prefilter를 진짜 column-only로** 만들 수 있음(worker와 달리 string retrieve 불요).
3. **name_id interning 대신 name_hash column 채택**: B1이 직접 입증한 "populate 비용은 hashing 아니라 traversal+collect" + parse 시점엔 global interner 없음 + hot path 속도는 u64 hash == u32 id(W16). interner(B1)는 worker cold-path 문자열 복원(B4)/메모리(B6)에서 소비.

**구현된 변경**:

- **B2 — `SiteCols` 도입** (graph.rs:800~, struct + flag 상수):
  - `struct SiteCols { name_hash u64, rel_path_hash u64, receiver_name_hash u64, language_id u16, access_kind_id u8, flags u8 }` = **32B, 문자열 0개** (vs RefSite ~292B). flags: `IS_DEFINITION|HAS_RECEIVER|IS_IMPORT_CONTEXT`.
  - 기존 `site_language_ids: Vec<u16>` 빌드(graph.rs:~5696)를 `site_cols: Vec<SiteCols>` 빌드로 교체(par_iter). 모든 필드가 RefSite에 이미 precompute돼 있어 **순수 복사**(별도 scan 없음). probe `site_cols_build=`.
  - language_id 사용처 3곳(prefilter + worker 2)을 `site_cols[i].language_id`로 라우팅. **behavior-identical refactor.**

- **B3a — 공유 맵 hash rekey** (prefilter가 문자열 안 읽도록, behavior-identical):
  - `bare/member_symbols_by_language_and_name`: `(u16,&str)` → `(u16,u64)` (name_hash). 빌드(symbol.name_hash) + `unique_symbol_by_language_and_name` 시그니처 + worker 2 callsite(site.name_hash) + prefilter 2 probe.
  - `import_targets_by_rel`/`import_facts_by_rel`/`type_facts_by_rel` **outer key** `&str` → `u64`(`stable_hash(rp)` == `site.rel_path_hash`, 동일 FNV). prefilter+worker file-cache lookup을 `.get(&rel_hash)`로.
  - **Checkpoint 1에서 invariant 유지로 정확성 입증** (rp가 file rel_path임이 확인됨).

- **B3b — column-only prefilter** (graph.rs:~5754, `ZOEK_SOA_B3` gated):
  - ON: inner loop이 `let c = site_cols[i]` (32B copy)만 읽고 **RefSite struct 전혀 안 읽음**. self/cls는 `stable_hash` 상수 비교, `types_by_name`/`star_import_facts_by_file` probe는 prefilter-local `AHashSet<u64>`(키 hash)로, star는 file당 1회 `cached_has_star`로 hoist.
  - OFF(default): 기존 W16 struct path(B3a rekey 반영). **paired ON/OFF 측정용**(같은 머신 상태에서 idle 불필요).
  - **안전성**: column path의 productive는 struct path의 **superset**(hash collision은 후보를 *추가*만, 누락 없음) → reference count 불변. 실측 after-count가 **완전 동일**(31,304,231)이라 collision divergence조차 없음.

**검증**:
- 75/75 lib tests pass (B2+B3a, B3b 후 각각) ✓
- captain2 references=**14,372,638** — OFF(B3a) + ON(B3b) **양쪽 모두** ✓
- schemaVersion=20 ✓, 컴파일 클린(SiteCols 모든 필드 column path가 소비)

**측정 (paired ON/OFF ×2, 인터리브, 고부하 load ~35-38; captain VSCode 상시 가동 + rebuild 128-worker self-load)**:

| run | load | site_cols_build | **phase_e_prefilter** | phase_e(worker) | invariant |
|---|---|---|---|---|---|
| **ON-1 (column)** | 37.97 | 2694ms | **420ms** | 20364ms | 14,372,638 ✓ |
| **ON-2 (column)** | 34.84 | 2855ms | **400ms** | 23217ms | 14,372,638 ✓ |
| **OFF-1 (struct)** | 37.69 | 2680ms | **2225ms** | 24536ms | 14,372,638 ✓ |
| **OFF-2 (struct)** | 35.89 | 2601ms | **2512ms** | 23226ms | 14,372,638 ✓ |

- **column-only prefilter: avg 2369ms → 410ms (−1959ms, −83%, 5.8배)** @ 동일 부하대. 두 pair 모두 일관(ON 420/400, OFF 2225/2512). **SoA 가설(292B struct → 32B column = cache traffic 9배↓) 결정적 검증.**
- `site_cols_build`은 ON/OFF 공통(2.68s) → prefilter delta는 순수 "struct vs column read" 격리. (Checkpoint 1 load~4서 site_cols_build=2464ms, 구 site_lang_id ~1.9s 대비 +~0.5s가 5개 추가 column write 비용.)
- **net(prefilter step, vs pre-SoA)**: build +0.5s − prefilter −1.8s = **−1.3s** 단독 흑자. 진짜 가치는 B4에서 worker(phase_e ~20s)도 column 읽어 2.68s build를 prefilter(31M)+worker(16M)에 분할상환할 때.

**W18 솔직한 진단 / 교훈**:
- 이전 ❌ SoA 시도(soa_cache 5.2s, SiteHot 3.7s)가 net-0이던 이유 둘 다 회피 확인: (1) build를 **기존 패스에 fuse**(별도 scan 0) (2) **소비처(prefilter)가 진짜 column-only**(문자열 안 읽음). 둘 중 하나라도 빠지면 net-0 — 이번엔 둘 다 충족.
- **고부하(load 38) 측정 주의**: struct path는 memory-stall bound라 oversubscription서 더 손해 → gap(−81%)이 idle보다 과장됐을 수 있음. idle(captain 종료) 측정은 미실시. 단 방향·부호는 명확(420 << 2225).
- prefilter는 전체의 ~3%라 절대 win은 작음(−1.8s). **B3의 진짜 목적 = B4 큰 cascade 전에 SoA를 싸게 검증** — 달성. 5.3배는 worker(B4)에서 더 큰 phase_e win을 강하게 시사.

**환경 변수 추가**: `ZOEK_SOA_B3=1` — column-only prefilter ON (default OFF=struct). paired 측정/B4 진입 전 default 승격 검토.

---

### 이번 세션 (W19) — B4: worker column-only (★ phase_e −16% 검증, SoA 진짜 prize 실현)

**먼저 한 일**:
1. optimization.md(W18까지) 읽고 75/75 + invariant=14,372,638 재확인. W1~W18+B1 모두 uncommitted, 빌드 green.
2. B4 전수 매핑: phase_e worker(graph.rs ~6076 loop)가 RefSite에서 읽는 **hot 문자열**은 `name`(expand+star), `rel_path`(star), `source_ref_id`+`edge_kind`(site_partial), `edge_kind`(add_resolution). receiver/enclosing 문자열은 **cache-miss(compute_receiver_resolution)에서만** 읽힘 — 즉 receiver_cache hit(흔함)이면 안 읽음.
3. 핵심 설계 결정: worker를 **HEAD(후보 수집, 게이트) + TAIL(후보 처리, 공유)** 로 분리. TAIL은 `c=site_cols[idx]`(48B)만 읽음 → 두 경로 공통. HEAD만 struct/column 분기.

**구현된 변경**:

- **B4 — `SiteCols` 확장** (graph.rs:813~): `enclosing_symbol_id_hash u64` + `site_partial u64`(precompute) + `edge_kind_id u8` 추가 → 32B → **48B**. `site_partial`은 기존 `site_partial_hash(&source_ref_id,&edge_kind)`을 site_cols build par_iter에 fuse(동일 함수 → **dedup key byte-identical**). 메모리 +16B/site × 38M ≈ +0.6GB → site_cols ~1.8GB peak(16GB 내).

- **B4 — hash-keyed 맵 2종 추가** (phase A, graph.rs:5424~): `members_by_container_and_name_h: AHashMap<(u64,u64), Vec<&Sym>>` 키 `(stable_hash(container), name_hash)` + `symbols_by_file_and_name_h` 키 `(rel_path_hash, name_hash)`. string 맵과 **병존**(compute_receiver_resolution cold-path가 string 맵 사용). 메모리 +~190MB. phase B에 `star_module_hashes_by_rel: AHashMap<u64, Vec<u64>>`(rel_hash → module hashes) 추가.

- **B4 — cols 헬퍼/구조체** (graph.rs ~6909, ~6981): `ReceiverResolutionCols`(borrow 0, lifetime 無) + `TypeTargetCols`(container qual/name hash precompute) + `receiver_resolution_to_cols`(검증된 `compute_receiver_resolution` 결과를 hash로 변환 — receiver당 1회, rare) + `expand_receiver_for_name_cols` + `star_import_candidates_into_cols`. **연산 순서·provenance 문자열을 string 버전과 정확히 일치**(dedup 결과 동일).

- **B4 — `add_resolution_count` 시그니처** (graph.rs ~7665): `site:&RefSite` → `edge_kind_id:u8`. `is_callish = edge_kind_id ∈ {CALL,CONSTRUCT}`(== 기존 `matches!(edge_kind,"call"|"construct")`). 6 worker callsite가 `c.edge_kind_id` 전달.

- **B4 — worker loop 재구조** (graph.rs ~6100 loop, `ZOEK_SOA_B4` gated):
  - **공유 TAIL**(후보 처리: site_partial=`c.site_partial`, add_resolution=`c.edge_kind_id`, name/rel_path hash=`c.*`, imported=current_file_imports.get(`c.name_hash`)). **RefSite 0** — 두 경로 공통. (default 경로도 이제 TAIL은 column read — behavior-identical refactor, invariant로 입증.)
  - **HEAD 게이트**: ON이면 SiteCols + hash-keyed 맵 + cols 헬퍼로 후보 수집, RefSite는 **receiver cache-miss에서만** fetch(hash pre-screen이 unresolvable receiver를 거름 → 흔한 경우 struct load 0). OFF면 기존 struct HEAD.
  - pre-screen side-set: `type_recv_hashes`(types_by_name 키 해시) + self/cls hash — process_chunk 진입 전 1회 빌드(soa_b4 시).

**검증** (전부 통과):
- `cargo build --release` green (신규 코드 전부 소비, unused 경고 0)
- `cargo test --release --lib` **75/75** (struct path) + **75/75** (`ZOEK_SOA_B4=1` column path)
- captain2 `referenceCount=14,372,638` — **default + column 양쪽 + paired 4 run = 6/6 정확** (collision 0)
- schemaVersion=20

**측정 (interleaved paired OFF/ON ×2, load 변동; django-erd 부하 환경)**:

| run | load1_before | **phase_e** | invariant |
|---|---|---|---|
| OFF-1 (struct) | 3.66 | 21078ms | 14,372,638 ✓ |
| ON-1 (column) | 9.03 | **17770ms** | 14,372,638 ✓ |
| OFF-2 (struct) | 15.01 | 18585ms | 14,372,638 ✓ |
| ON-2 (column) | 8.14 | **15419ms** | 14,372,638 ✓ |

- **phase_e: OFF avg 19831ms → ON avg 16595ms = −3.2s (−16%)**. **모든 ON < 모든 OFF**(일관). 특히 ON-1(load 9.03)이 더 낮은 load의 OFF-1(load 3.66)보다 3.3s 빠름 — **더 높은 부하서도 더 빠름** → 부하 노이즈 뚫는 강한 신호.
- 직전 back-to-back 단일 비교(20.2 vs 19.6, ON 느림)는 **django-erd 98% + 연속측정 load 누적**으로 ON이 더 높은 부하서 돌아 오염된 것 — paired 교차로 해소.

**W19 솔직한 진단 / 교훈**:
- **SoA 가설이 worker에서도 실현** — 단, prefilter의 5.8배가 아닌 **−16%**. 예측대로: worker는 per-site struct read 외에 **candidate 처리(large global-map probe + counts/dedup insert)** 작업이 큼. B4가 제거한 건 (a) 292B struct cold-load (b) string hashing/memcmp(u64 probe로). 남은 비용은 `members/symbols_by_file` 대형 맵 bucket-miss + add_resolution/push_light insert — B4 무관. → **다음 phase_e 추가 win은 그 대형 맵 probe 공략**(B5/별도).
- **prefilter는 sequential 0..38M 스캔이라 48B vs 292B가 지배(5.8배)**; worker는 productive index(file-grouped, semi-sequential) + 무거운 처리라 per-site read 비중이 작아 −16%. 둘 다 SoA 이득이나 비중이 다름.
- **default 경로 TAIL도 column read로 바뀜**(공유) — invariant 6/6로 byte-identical 입증. OFF는 이제 "struct HEAD + column TAIL"이라 순수 pre-B4가 아니나, 게이트의 목적(HEAD struct vs column A/B)은 그대로.

**환경 변수 추가**: `ZOEK_SOA_B4=1` — column-only worker ON (default OFF=struct HEAD). `ZOEK_SOA_B3`(prefilter)와 독립.

**B3+B4 승격 권장 (다음 세션 첫 후보)**: B3(prefilter −1.8s) + B4(worker −3.2s) 둘 다 strict-improvement·invariant 검증 완료. gate 제거(default ON) → cold rebuild에서 phase_e+prefilter 합 **−5s** 실현. 단 struct 경로 삭제는 B6(RefSite retire)와 묶는 게 깔끔 → 판단은 사용자. 현재는 둘 다 gated(안전). **→ W20에서 승격 완료(struct 경로는 `ZOEK_SOA_OFF` opt-out으로 보존, 삭제는 B6).**

---

### 이번 세션 (W24) — B6 착수: peak RSS 측정(★캡 초과 발견) + raw_text 드롭(stage 1)

**먼저 한 일 / ★ peak RSS 측정 (doc B0 "측정 토대")**: `/usr/bin/time -l` max RSS, captain2:
- **OV1 ON(default): peak 17.0~18.0GB — 문서 하드캡 16GB 초과!**
- **OV1 OFF(`ZOEK_OVERLAP_STATIC_OFF=1`): peak ~15.95GB (캡 경계)**
- → **OV1(wall −2.8s)이 peak를 ~+2GB 올린다**(overlapped ref_site write 버퍼 ~2GB가 resolve working-set과 공존). **wall↔memory 실제 충돌**: OV1 default-ON이 16GB 예산 초과. 16GB RAM 머신선 OOM/swap 위험(이 머신은 RAM 충분해 완료되나 doc "하드 제약 ≤16GB" 위반).
- peak는 **run-to-run ±~1GB noise**(OV1 버퍼 타이밍) — 단일 measure 신뢰 금물.

**구현 (B6 stage 1 — `raw_text` 필드 드롭)**:
- RefSite ~280B inline struct × 38M ≈ **10GB+가 메모리 hog**. full retire(→columns)는 멀티세션이라, 안전·완료가능한 첫 stage로 redundant `raw_text` 제거.
- `raw_text`는 parse서 항상 `==name`, 디스크는 marker-0으로 인코딩하고 fresh write가 marker-1을 절대 안 냄 → 불변. 드롭 후 cold path(serialize marker 항상 0, `serialize_reference_binary_from_light`/`materialize_light_ref`/`push_resolved_reference`는 `name`, `parse_ref_site_binary`는 marker cursor advance 유지·discard)에서 `name`으로 복원.
- 부수익: `name: name.clone()` → `name: name`(move) — **38M name clone 제거**(parse alloc↓).
- **검증**: 75/75, referenceCount **14,372,638**, **bytes 3,788,145,402(byte-identical)**, schemaVersion 20. data −~1.8GB(코드상 명백)이나 peak RSS noise+OV1 +2GB에 가려 peak로는 확인 어려움.

**W24 진단/결론**:
- 리빌드 peak가 16GB 캡 경계~초과. **OV1이 캡 초과 주범**(+2GB). **근본 = full B6**(RefSite AoS drop→columns ~90B→−6GB→peak ~11-12GB, 캡 여유+OV1 수용). B6가 OV1을 감당 가능하게 만드는 synergy.
- **★ OV1 default-ON 결정 = 유지 (사용자, wall 우선)**: −2.8s wall 위해 +2GB peak(16GB 캡 일시 초과)를 **full B6 완료까지 감수**. captain2 머신은 RAM 넉넉. **단 16GB RAM 유저 머신 배포 전엔 full B6로 peak를 캡 아래로 내려야 함**(또는 그 환경선 `ZOEK_OVERLAP_STATIC_OFF=1`). 즉 OV1+16GB 양립의 전제 = full B6.
- raw_text 드롭 유지(정확·유익). **다음 세션: full B6**(columns+interner+RefSite drop, −6GB) — OV1을 캡 내로 수용하는 근본 작업.

---

### 이번 세션 (W23) — write/index 재프로파일: 타겟은 reference가 아니라 ref_site static write

**먼저 한 일**: 사용자 = wall 우선 → "writer D1b"(per-worker shard writer). 단 profile 먼저(W10 write 프로파일은 채널 ON 이전). index 윈도우(phase_f 후 10s) sample.

**index 윈도우 leaf (resolve=35.8s, index=8.3s, total=56.2s)**:
- `__psynch_cvwait` 289K(parking ~70%) + `_platform_memmove` **64758** + rayon plumbing ~88K + **`serialize_ref_site_binary` 55706(#1 named)** + serialize_symbol_binary 8941 + **serialize_reference_record 3625뿐**.
- → **write 병목은 reference가 아니라 ref_site(38M) static shard write**다. references(14M)는 **이미 채널로 resolve에 overlap**(W16)돼 index에 거의 없음. ref_sites(38M)·symbols(4M)·facts는 `write_graph_shards`(index phase, **resolve 후**)서 씀.

**구조 확인**:
- `index` 타이머는 finish(references) 후 시작 → index 8.3s = `write_graph_shards`(symbols+ref_sites+facts+hierarchy+counts). channel path선 `references_streamed=true`라 reference shard skip.
- `write_ref_sites_by_file_shards`(graph.rs:9841 full-rebuild 경로)는 **이미 내부 병렬**(Stage1 par_iter serialize→per-worker per-shard bufs, Stage2 par shard별 write_all). 불가피한 2 copy(serialize→buf, buf→BufWriter)뿐 — **내부적으로 더 짜낼 게 없음**. memmove 64K가 이 copy.
- ❗ **`append_ref_sites_to_file_shards`(graph.rs:8930)는 단일스레드 sequential지만 `ZOEK_SKIP_RESOLVE` fast-path 전용** — captain2(resolve) 경로는 안 탐(혼동 주의).

**★ 구현 (W23 OV1) — ref_site write를 resolve와 overlap**:
- ref_site shard write(38M, index의 dominant)를 **resolve scope에 dedicated rayon pool**(W1 패턴 — global pool과 분리, W14 nested-deadlock 회피)로 spawn. `write_store`/`write_graph_shards`에 `skip_ref_sites` 추가 → index의 ref_sites_h를 Ok(0)로 skip. **같은 `stream_file_table`** 사용이라 shard bytes 동일.
- gate `ZOEK_OVERLAP_STATIC_WRITE`(default OFF), pool 크기 `ZOEK_OVERLAP_STATIC_THREADS`(default 4). overlap thread가 쓴 byte는 `write_store` 반환 bytes에서 빠지므로 summary에 다시 합산(정확한 total 유지).
- **measured (paired, matched idle ~2.5)**:

  | | resolve | **index** | total | bytes |
  |---|---|---|---|---|
  | OFF | 33566ms | **6544ms** | 51637ms | 3,788,145,402 |
  | ON | 34327ms | **2802ms** | 48842ms | 3,788,145,402 |

  **index −57%(−3.7s)**, resolve +0.76s(경합, 작음), **total −2.8s 순이득**. **bytes 동일=byte-identical**(disk: ref-sites shard 2.04GB 정상 + 총합 3.79GB=baseline). invariant 14,372,638, 75/75, deadlock 없음.

**W23 진단/결론**:
- **profile이 타겟을 정정**(D1b-for-references는 references가 이미 overlap돼 무의미; 진짜는 ref_site static write의 **overlap**). 구현해서 **−2.8s 검증**.
- 경합(+0.76s)은 작음(dedicated 4-thread가 128-worker phase_e를 거의 안 건드림). pool 더 줄이면(2) 경합↓ 가능하나 write는 여전히 resolve 뒤로 숨음.
- **★ 승격 완료 (default ON)**: gate를 `ZOEK_OVERLAP_STATIC_WRITE`(default OFF) → opt-out `ZOEK_OVERLAP_STATIC_OFF`(default ON)로 반전. default rebuild 재검증: refs 14,372,638 + bytes 3,788,145,402 + index 2768ms ✓, opt-out + default 둘 다 75/75. channel pipeline서만 활성(writer가 그 scope에 삶) — `ZOEK_DISABLE_LIGHT_CHANNEL` 시 자동 fallback. **단 concurrency라 실사용 부하/incremental-path/소형 corpus에서 추가 관찰 권장**.
- **❌ OV2 시도→revert (measure-driven)**: symbols(1.1GB)+facts(0.3GB)도 같은 dedicated pool로 overlap 확장. paired(matched idle): index 4606→**690ms**(−85%, 거의 0)이나 **resolve +2121ms**(OV1의 +760ms보다 큼 — static writer가 3 family치 work로 resolve 코어를 더 뺏음). **net −2.3s로 OV1(−2.8s)보다 작음**. byte-identical(검증)이나 **contention이 추가 index 이득을 먹음**(실사용 부하선 더 나쁠 위험). → **revert, OV1(ref_sites-only)이 sweet spot.** 교훈: overlap은 oversubscribed(128 phase_e) 환경서 코어 경쟁이라, 가장 큰 단일 항목(ref_sites 38M) 하나만 overlap하는 게 최적; 더 얹으면 resolve penalty가 index 이득 초과.
- 누적(이 세션): W20 resolve −5~8s + W21 parse −2~3s + W23 index −2.8s.

---

### 이번 세션 (W22) — phase_e 재프로파일(옵션 C ✗) + B6 범위 정정(resolve-time만, 디스크 불변)

**먼저 한 일**: 사용자가 "가장 소득 큰 것" → 옵션 C(per-file sequential resolve) 선택. 단 문서 원칙(profile 첫, ❌C2 교훈)대로 **착수 전 phase_e 재프로파일**(B4 이후 hot leaf 미확인). 결과가 방향을 바꿈.

**phase_e 프로파일 (profiling build, 12s sample, phase_e=20.6s, default column path)**:
- **`__psynch_cvwait` 235K → 거의 전부 `rayon WorkerThread::wait_until_cold → Sleep::sleep`**(워커가 할 일 없어 잠듦). **`semaphore_wait_trap` 166K → `rayon bridge_producer_consumer/join_context`**. **채널 send은 166K 중 ~145-239 samples뿐** → **backpressure 아님.**
- → **phase_e 20.6s의 ~65%가 rayon oversubscription parking**(128스레드 vs ~14코어; W12 sweep의 "cvwait 60%" 재확인 — 더 많은 워커가 memory-stall 숨김). 실 compute(worker closure 213K + compute_receiver_resolution 21K + memcmp 18K + memrchr 11K + hash 18K + memmove 9K + serialize_reference_record 5K)는 **분산**.
- **대형 맵 probe(`members_by_container_and_name_h`/`symbols_by_file_and_name_h`)가 깔끔한 dominant leaf가 아님** — hashbrown get/insert는 ~8K visible(나머지 closure inline). **이게 ❌C2 실패 조건과 동일**(맵 probe가 생각만큼 안 큼).

**→ 옵션 C 기각 (데이터 근거)**: per-file mini-context는 맵 probe 비용을 노리는데, profile상 그게 dominant가 아니고 parking은 oversubscription(맵과 무관)이라 C2처럼 헛돌 위험 큼. **가설 기반 큰 rewrite 전 profile 검증 — 정확히 이 단계에서 방향 전환(문서가 줄곧 강조한 가치).**

**사용자 재선택 = B6 (RefSite retire, 근본/메모리)**. B6 범위를 전수 매핑하니 RefSite reader가 25+ 함수(rel_path 35회·name 14회·enclosing 11회…) + **디스크 shard 포맷(`serialize_ref_site_binary`)·incremental read(`parse_ref_site_binary`) 경로까지** 얽힘.

**★ B6 범위 정정 (중요 — 원래 doc B6보다 좁힘)**:
- 핵심 통찰: `append_ref_sites_to_file_shards`(디스크 write, graph.rs:1957)는 **parse 직후·resolve(2192) 전**에 실행. 즉 메모리 −6GB는 *resolve 중* `Vec<RefSite>`만 안 들면 됨 → **RefSite를 디스크 write까지 유지 후 resolve 직전 drop**. **디스크 write + incremental read 경로는 RefSite 그대로 유지(안 건드림)** → 변환 대상이 **resolve-time reader로 한정**: ① phase_e worker cold path(`compute_receiver_resolution`: rel_path/receiver/enclosing) ② phase_f edge_key(`source_ref_id`+`edge_kind` → `site_cols.site_partial`로, byte-identical) ③ `materialize_light_ref`(spill/legacy, 전 필드 복원 → NameInterner reverse table + file_id/u64 필요).
- 필요 인프라: SiteCols에 복원 컬럼 추가(name_id u32, receiver_name_id u32, enclosing_id_u64, source_ref_id_u64; rel_path=file_id; 위치 start/end). NameInterner(B1)에 **reverse `Vec<Box<str>>`**(id→&str) 추가(현재 없음).
- 단계: (B6a) SiteCols 복원 컬럼 + interner reverse 빌드(coexist, unused) → (B6b) resolve-time reader 3종을 컬럼으로 → (B6c) resolve 진입 전 `Vec<RefSite>` drop + resolve 시그니처 컬럼화. 각 단계 게이트 75/75 + invariant 14,372,638 + **bytes=3788145402**.

**⚠️ 솔직한 wall/memory 진단 (다음 세션 의사결정 입력)**:
- **B6의 확실한 prize = 메모리 −6~7GB**(resolve peak서 RefSite 7.6GB drop) + 16GB cap 여유 + delta 작업 토대. site_cols 빌드 재배치.
- **B6의 phase_e WALL 이득은 불확실/modest**: hot path는 **이미 SiteCols(B4)**라 per-site hot 트래픽 불변. 메모리 −6GB가 글로벌 캐시 압력을 낮춰 stall을 일부 줄일 순 있으나(추정), parking 주원인(oversubscription)은 B6와 무관. **즉 30s wall 목표엔 B6 직접 기여 작음 — 주로 메모리 레버.**
- 코드 변경 없음(W22는 투자 전 de-risking 조사). 다음 세션: B6 착수(메모리 우선) vs wall 우선(writer D1b/site_cols 재배치) 재고 — 사용자 목표(wall vs memory)에 달림.

---

### 이번 세션 (W21) — parse 공략: 옵션 A 전제 정정 + P1(ref_sites 할당) + P2(sanitize Cow)

**먼저 한 일 / 핵심 발견**:
1. 사용자 지시 = "parse 공략". 옵션 A는 "tree-sitter → custom tokenizer"였으나 **Cargo.toml에 tree-sitter 의존성이 전혀 없음** → parse는 **이미 hand-written regex/string 파서**. `build_file_graph`(graph.rs:3079)가 파일당 `extract_symbol_defs`/`extract_import_facts`/`hierarchy`/`materialize`/`assign_bodies`/`extract_type_facts`/`extract_function_return_facts`/`extract_ref_sites` 호출. 옵션 A의 본질은 **이 추출 함수들의 최적화**(교체할 tree-sitter 없음).
2. **내장 `ZOEK_PARSE_PROFILE=1`** 발견 — 8 sub-phase를 atomic ns 누적으로 분해. captain2(load~3) 결과(128워커 CPU합, parse wall 13.2s):

   | sub-phase | CPU ms | % |
   |---|---|---|
   | **ref_sites** | 245011 | **46.1%** |
   | **symbol_defs** | 104116 | **19.6%** |
   | **type_facts** | 97569 | **18.4%** |
   | import_facts | 40162 | 7.6% |
   | materialize | 35076 | 6.6% |
   | 나머지(hierarchy/assign/fn_returns) | ~9500 | 1.8% |

3. **parse leaf sample**(profiling build, parse 윈도우 10s): malloc/free churn ~88K(`_xzm_malloc_tiny`+`_xzm_free`+freelist) + string scan ~92K(`sanitize_code_line` 34K + `StrSearcher`/`CharSearcher`/`str::find` ~47K) + file I/O ~86K(open/read/close 135K 파일) + lock wait ~67K(`__ulock_wait`, 128스레드 malloc 경합 의심) + memmove ~41K. → **할당 churn이 최대 단일 카테고리** → P1.

**구현된 변경**:

- **P1 — `extract_ref_sites` 할당 감축** (graph.rs:5091~, struct 700~):
  - **`uri` 필드 제거**: RefSite.uri는 post-parse 어디서도 안 읽히고 `serialize_ref_site_binary`도 안 씀(`parse_ref_site_binary`는 이미 `uri: String::new()`로 reload) → **완전 dead인데 38M×~70자 할당**. struct에서 제거(생성자 2곳·caller 1곳 정리).
  - **`rel_path`/`language`/`edge_kind`/`access_kind` → `Arc<str>`**: 파일 상수(rel_path/language) + 고정 소집합(edge/access)을 **파일당 1회 Arc 할당 후 per-site `clone()`(refcount bump)**. 기존 38M×4 String 할당+memcpy 제거. serde `"rc"` feature 추가(bincode spill용). readers는 deref(`&*`/`.as_str()` 일부 조정), `materialize_light_ref`/`push_resolved_reference`의 GraphReference.uri는 `Box::from("")`(lazy-fill 계약).
  - **측정(matched-load paired, load 2.43 vs 2.44; gate `ZOEK_PARSE_P1_OFF` 후 제거)**: ref_sites CPU **181434→160914ms(−11.3%)**, parse wall **10913→9797ms(−1.1s)** — 공유분만(uri 양쪽서 이미 제거). uri 제거분(~−1s 추정) 합쳐 **parse ≈ −2s + 메모리 절감**.

- **P2 — sanitize Cow** (graph.rs:12314~):
  - `sanitize_code_line`/`sanitize_python_ref_site_code_line`/`sanitize_ref_site_code_line` 반환 `String` → **`Cow<'a, str>`**. quote/comment trigger 없는 clean 라인(`def f(x):`, `import os` 등)은 **borrow**(할당 0); trigger 있으면 기존 owned 빌드. type_facts/ref_sites가 라인마다 호출(sample #2 leaf).
  - ⚠️ **버그 발견+수정 (W21 핵심 교훈)**: 초기판이 **invariant(14,372,638)는 통과했으나 `bytes`가 119KB 달랐다**(P1=3788145402, 초기 P2=3788264475). 원인: `sanitize_code_line` owned가 `//`를 **언어 무관**하게 주석 break하는데(`ch=='/' && peek=='/'`, python 게이트 없음), python fast-path가 `/` trigger를 누락 → python `a // b`(정수나눗셈) 라인서 borrow(전체) vs owned(`//`서 잘림) divergence. type_facts(python) 출력이 미세하게 달라졌으나 ref count는 우연히 불변. **수정**: `/`를 모든 언어 trigger로. 수정 후 **bytes=3788145402 복귀**(byte-identical 입증).

**검증 (전부 통과)**:
- build green, `cargo test --release --lib` **75/75**
- captain2: **referenceCount=14,372,638 + symbolCount=4,141,426 + bytes=3788145402 + schemaVersion=20** (P1+P2-fix). **P1+P2는 원본 출력과 완전 byte-identical** — 순수 성능/메모리 최적화.

**W21 솔직한 진단 / 교훈**:
- **옵션 A는 전제부터 틀렸다**(tree-sitter 없음). doc의 "parse: tree-sitter"는 부정확 — 실제는 custom regex. 진짜 parse 공략 = 추출 함수의 할당/스캔/`//`I/O 최적화.
- **`bytes`도 게이트에 넣어야 한다**: ref count(invariant)는 출력 divergence를 못 잡았다(P2 버그가 count 불변·bytes만 119KB差). parse류 변경엔 `referenceCount` + `symbolCount` + **`bytes`** 3종 모두 비교.
- **측정 한계**: parse wall이 load 3→7서 13→21s 출렁, profile CPU-sum도 load 의존 → **matched-load paired**(gate 후 즉시 OFF/ON)만 신뢰. P1 −11%(공유분)는 matched paired로 확정.
- P1+P2 합쳐 **parse −2~3s + 메모리 절감**(in-memory ref_sites: uri 제거 + 4필드 per-file 공유). 30s엔 부족 — 남은 parse hot은 **스캔**(sanitize/tokens/receiver)·**file I/O**(135K 파일)·**malloc 경합**이고, type_facts(18%)는 sparse한데 전 라인 sanitize(fast pre-check skip 여지).

**환경 변수**: 신규 영구 flag 없음(`ZOEK_PARSE_PROFILE`은 기존, `ZOEK_PARSE_P1_OFF` 측정 게이트는 제거함). serde `"rc"` feature는 Cargo.toml에 추가됨(Arc<str> 직렬화).

---

### 이번 세션 (W20) — B5: phase_c column-only + B3/B4/B5 default 승격

**먼저 한 일**:
1. optimization.md(W19까지) 읽고 build green + 75/75 + invariant=14,372,638 재확인. W1~W19+B1 모두 uncommitted.
2. 30s 목표 재확인 — SoA 점진 step(B3~B5)은 합쳐 −5~6s대라 30s엔 부족(parse+index 큰 레버 필요). 이번 세션은 **SoA 경로 마무리(B5) + 검증된 win을 default로 승격**해 normal run에 실현하는 데 집중.
3. **B5 cascade 전수 매핑**: phase_c_process_chunk는 38M ref_sites **전체 sequential scan**(prefilter와 동일 구조 — B3서 5.8배 나온 그 패턴). RefSite read = `name`(symbols_by_name probe + may-map 키), `rel_path`/`language`(scope/lang hash, cached), `&RefSite`(likely_sites Vec, phase_f가 source_ref_id/edge_kind로 edge_key + offset_from). 소비처: may-maps→phase_d(`symbol.name`), likely-maps→이미 (u64,u64,u64), likely_sites→apply_token_shape.

**구현된 변경 (B5)**:

- **`symbols_by_name` 제거 → `symbol_name_hashes: AHashSet<u64>`** (graph.rs 심볼 빌드 루프). phase_c가 유일 reader였고 `contains_key`만 씀 → name_hash 집합 probe로 교체(W9b 패턴). string 맵/빌드 비용 제거 부수익.
- **may-maps `&str`→`u64`(name_hash)** (`PhaseCAccums` + merge + phase_d 소비 `symbol.name_hash`). 4개 맵.
- **likely_sites `Vec<&RefSite>`→`Vec<u32>`(global site_idx)** (`PhaseCAccums` + `ResolveIntermediate` 2필드 + apply_token_shape 시그니처/본문). phase_f는 `ref_sites[idx]`로 (rare) push — **`offset_from` unsafe 제거** 부수익. `ResolveIntermediate`가 더 이상 `ref_sites`를 borrow 안 해 **lifetime `<'a>` 제거**.
- **site_cols 빌드를 phase_c 앞으로 이동** (was phase_d 뒤). `ref_sites`에만 의존(parse 시 전부 precompute)이라 order-safe, 총 작업 불변·위치만.
- **phase_c_process_chunk 재작성** (`(ref_sites, site_cols, start, end, symbol_name_hashes, soa_b5)`): per-site는 `site_cols[i]`(48B)에서 name_hash/edge_kind_id/access_kind_id/is_def/rel_path_hash. **scope_hash+lang_hash는 rel_path 경계서만** ref_sites string read(파일당 language 일정 → 함께 갱신; language_id로 캐싱하면 unknown=id 0 충돌로 lang_hash divergence라 **string 재해시 유지가 정확**). boundary 검출은 rel_path_hash(u64) 비교. `soa_b5`(OFF면 ref_sites struct read) gate — 두 경로 동일 맵 생성(behavior-identical, invariant로 입증).

**B5 검증/측정**:
- build green, **75/75**(default + `ZOEK_SOA_B5=1` + `ZOEK_SOA_OFF=1` 셋 다), invariant **14,372,638**(B3+B4+B5 all-on + default + OFF 양쪽).
- **paired isolated (B3+B4 ON 고정, B5 OFF vs ON, idle load 1.8~2.8)**: phase_c **2408ms → 1636ms = −772ms(−32%)**, ON이 더 높은 load서도 빠름(robust). all-struct 대비는 −47%(2.4~3.4s→1.36~1.64s).

**B3/B4/B5 default 승격**:
- 3 gate `let soa_bX = env("ZOEK_SOA_BX").is_ok()`(default OFF) → `env("ZOEK_SOA_OFF").is_err()`(**default ON**, 단일 opt-out). struct 경로(prefilter OFF branch + worker struct HEAD + phase_c struct read)는 보존 — **삭제는 B6와 묶음**(사용자 판단 영역).
- site_cols 빌드(~3.0~3.4s)는 B2부터 **무조건** 지불 중(site_language_ids 대체)이라 승격은 build 비용 추가 0, 3 pass의 read를 column으로 전환만.

**승격 후 paired (default column vs `ZOEK_SOA_OFF` struct, load~2.8 동일 window, 다중 run)**:

| phase | OFF struct (2 run) | default column | 신뢰도 |
|---|---|---|---|
| **phase_e_prefilter** | 3292 / 2998ms | **145ms** | **−95% 확고**(B3, 일관) |
| **phase_c** | 3410 / 2562ms | **1357ms** | **−47%(~−1.2s) 확고**(B5) |
| phase_e | 29817 / **18851**ms | 19901ms | **noise 지배** — 첫 OFF 29.8s는 **load spike**(2nd 18.9s로 정정). B4 −16%는 **부하서만**(idle marginal) |
| total wall | 113.2 / **90.3**s | 86.8s | calm −3.5s, 단 spike run은 −26s(노이즈) |

**W20 솔직한 진단 / 교훈**:
- **신뢰 가능한 idle 누적 win ≈ −4s** (prefilter −2.85s + phase_c −1.2s, 양쪽 일관). phase_e(B4 −16%)는 **idle선 noise에 묻히고 실사용 부하(captain 상시 가동)서 드러남** → 실환경 추가 −3s+. 즉 **default 승격으로 실사용 −5~8s 실현**(부하 클수록 큼).
- **W15 교훈 강하게 재확인**: 첫 OFF run이 113s/phase_e 29.8s로 −26s win처럼 보였으나 2nd OFF가 90s/18.9s → **load spike 아티팩트**. 단일 wall 절대 신뢰 금물, phase-단위(prefilter/phase_c는 CPU-bound라 −95%/−47% 일관)만 신뢰.
- **30s 목표까지**: SoA(B3~B5) 누적은 −5~8s(부하 의존)로 마무리. 남은 큰 덩어리 = **parse ~12s(옵션 A custom tokenizer −7~9s)** + **index/write ~20s(옵션 D −3~6s)**. 멀티세션 필요.

**환경 변수 변경**: `ZOEK_SOA_B3/B4/B5` 개별 gate(default OFF) → **`ZOEK_SOA_OFF`** 단일 opt-out(default는 column ON). `ZOEK_SOA_OFF=1` = 전 struct 경로(paired 측정/디버깅). `ZOEK_SOA_B1`(interner 측정)은 그대로.

---

## 🎯 다음 큰 작업: 옵션 B (RefSite full SoA + interning) — 실행 blueprint

> **세션 W16에서 사용자 확정. 이 섹션이 다음 세션의 시작점.** 큰 cascade(3~5주)라 단계별 빌드-green + invariant 14,372,638 게이트 유지가 필수. 한 번에 다 바꾸지 말 것.

### 결정 배경 (W16)
- **목표 해석 (사용자)**: "둘 다 중요" — cold full rebuild + 편집 중 incremental. **delta는 후속**, 지금은 **phase_e/cold path 근본 개선**부터.
- **왜 옵션 B**: phase_e가 단일 최대 단계(idle ~14s, 부하 19~23s)이고 **memory-stall bound** — cvwait 60%(pool sweep 확인) + RefSite ~292B AoS struct cold-load. incremental 문자열-해시/memcmp 미세조정(W2~W16)은 세션당 −1~3s 한계 도달 확인. −10s는 SoA만 가능.
- **메모리 부수 효과**: 현재 ref_sites ~7.6GB → SoA+interning 후 큰 폭 절감 (16GB cap 여유 + delta 작업에도 유리).

### ⛔ 반복 금지 교훈 — "half-measure SoA" (이전 ❌ 실패 재확인)
hot 정수 필드만 병렬 Vec로 빼고 **문자열(name/rel_path/receiver/enclosing)은 RefSite에 남기면**, worker가 그 문자열 위해 여전히 292B struct 로드 → **cache-miss 패턴 불변 → 효과 0** (시도1 soa_cache 5.2s 빌드, 시도2 SiteHot 3.7s 빌드 — 둘 다 phase_e 무변화). **진짜 win = 문자열까지 u32 id interning**해서 worker inner loop이 dense column만 읽게 하는 것.

### RefSite 필드 인벤토리 (전수 조사, graph.rs) — 설계 입력
- struct RefSite: graph.rs **700~746**. 생성 2곳: `extract_ref_sites` (5045~5068), `parse_ref_site_binary` (10381~10404). FIXUP(load 후 재해시 루프): **1690~1705**.
- **hot phase가 &str로 읽는 필드만** (interning 핵심 타겟):

  | 필드 | PREFILTER(31M) | WORKER(16M) | PHASE_C(38M) | 처리 방향 |
  |---|---|---|---|---|
  | **name** | (lang,name) map key (5624/5632) | expand/unique/star (5852/5888/5996/6406) | map key (7281+) | name_id(u32) interning, (lang,name) map → (lang,name_id) |
  | **rel_path** | import/star maps (5602) | import maps+recv_res+star (5787/5837/6404/6323) | scope hash (7298) | rel_path_id = **file_table id 재사용** |
  | **receiver_name** | self/cls + types_by_name (5612) | self/cls + types + recv_res + star (5802/6398) | — | receiver_name_id (name interner 공유) |
  | **enclosing_symbol_id** | — | recv_res + star + fact-eq (5839/6407/6921) | — | "sym:HEX16" → **enclosing_id_u64** (interning 불요) |
  | **source_ref_id** | — | hash만 (5903) | — | "ref:HEX16" → **source_ref_id_u64**, site_partial 정수 mix |
  | **edge_kind** | — | hash(5903)+eq(7357) | — *(edge_kind_id 사용)* | edge_kind_id 이미 있음 |

- **hot path가 문자열 전혀 안 읽음** (그냥 column, interning 무관): rel_path_hash, name_hash, receiver_name_hash, enclosing_symbol_id_hash, access_kind_id, edge_kind_id, is_definition, is_import_context, language(→`site_language_ids[]` 이미 존재).
- **cold-only 문자열** (serialize/materialize에서만): `uri`(serialize조차 안 함, parse 시 ""), `access_kind`(OTHER fallback write만), `raw_text`(==name marker), `language`(serialize lang_id).
- **MATERIALIZE** (`materialize_light_ref`/`push_resolved_reference` 7859~7910): GraphReference로 source_ref_id/edge_kind/name/raw_text/uri/rel_path/enclosing 복사 (test/legacy + light path). interner→&str 복원 필요 (cold).

### SoA 설계
1. **Interners** (parse 후 1회 빌드, resolve 동안 immutable):
   - `name_interner`: u32 → (Box<str>, name_hash u64). **name + receiver_name 공유** (~1.5M 고유). hash를 동반 저장 → FIXUP 재해시 루프(1690) 제거 가능.
   - rel_path: **file_table 재사용** (이미 path→u32 id intern 중). rel_path_hash 동반.
   - source_ref_id / enclosing_symbol_id: interning 대신 **u64 parse** (`parse_stable_*_to_u64`). enclosing 0=None.
2. **RefSiteColumns** (Vec per field, idx=site_idx; AoS struct 제거):
   - 정수 hot: name_hash u64, rel_path_hash u64, receiver_name_hash u64, enclosing_symbol_id_hash u64, access_kind_id u8, edge_kind_id u8, flags u8(is_def|is_import), language_id u16
   - id columns(문자열 복원용): name_id u32, rel_path_id(=file_id) u32, receiver_name_id u32(0=None), enclosing_id_u64 u64, source_ref_id_u64 u64
   - cold: start_line/col/end u32×4, raw_text marker(대부분 ==name), uri(drop)
   - → hot loop은 정수+id column sequential read(file-grouped bucket prefetch 친화). 문자열은 `name_interner.str(id)`로 rare 경로만.
3. **부수 cascade (문자열 map → id/hash)**:
   - `types_by_name`(&str) → receiver_name_hash 또는 name_id key (self/cls sentinel)
   - `member_symbols_by_language_and_name` / `bare_symbols_by_language_and_name`: (u16,&str) → (u16, name_id 또는 name_hash)
   - **`compute_receiver_resolution` / `expand_receiver_for_name` 시그니처: &str → id/hash** (B4 최대 cascade)

### 마이그레이션 단계 (각 단계 후 75/75 + invariant 게이트, 빌드 green)
- **B0 측정 토대**: **captain VSCode 종료한 진짜 idle** paired baseline 3run (phase_e/parse/total 못 박기) + profiling build phase_e leaf 재캡처(기준점).
- **B1 Interner 인프라 ✅ (W17 세션 완료)**: `NameInterner` (graph.rs:748~, `AHashMap<Box<str>, u32>` + `hashes: Vec<u64>`, `MISS=u32::MAX`) + `ZOEK_SOA_B1` flag 뒤 측정 블록 (phase_a 직후 ~5433). **normal run/tests/invariant 영향 0** (gated, 아직 미소비).
  - **측정 (load 5~9, idle 아님; 2 run)**: `interner_build=254~281ms` (4.1M symbol names → **unique=614,994**), `populate_by_hash=1908ms` vs `populate_by_str=1695ms` (38M par_iter), `interned_hit=93.3%` (35.6M/38M site name이 symbol name과 매치 — 나머지 MISS는 어차피 probe miss라 정확), `approx_mem=317~401MB`. invariant 14,372,638 ✓, 75/75 ✓.
  - **리스크 #1(build cost) 해소**: 이전 ❌ 5.2s → interner_build **~280ms** (압도적). 접근법 viable 확정.
  - **반전 통찰 (B2 설계 결정)**: hash-keyed populate(`name_hash→id` u64 probe)가 string-keyed보다 **안 빨랐음** (1908 vs 1695ms — 단 hash는 `collect::<Vec>` 152MB 쓰기 포함, str는 `count`만이라 unfair). 결론: **populate 비용은 string hashing이 아니라 (a) 38M AoS struct traversal의 cache-miss + (b) 152MB column collect 자체가 지배** ("짧은 이름 AhHash는 u64와 차이 없다" W16 통찰 재확인). 즉 column build는 *AoS를 한 번 읽어 SoA로 만드는 불가피한 1회 비용*(~1.7-1.9s @ load, idle ~1s).
  - **→ B2는 별도 38M scan으로 column을 만들지 말고, 이미 site를 순회하는 pass에서 빌드**: 최선은 **parse/extract_ref_sites 시점 inline 할당**(parse 128-way 병렬 → per-file local interner 후 merge, 또는 sharded concurrent interner). 그러면 populate 비용이 parse에 흡수돼 사라짐. 차선은 resolve 첫 site-traversal(prefilter)에 fuse.
  - **net-win 조건 재확인**: column build 1회 비용(~1s)은 phase_e prefilter(31M)+worker(16M)+phase_c(38M) **3 pass가 AoS 대신 column을 읽어** 분할상환돼야 흑자. 단일 map rekey로는 못 봄(doc half-measure 경고) → B3는 prefilter가 RefSite를 **전혀** 안 읽는 수준까지 가야 첫 측정 win.
  - unique_names가 예상(1.5M)보다 적은 **615K** — 이름 반복도 높음 → interner 메모리/probe 더 유리.
- **B2 SiteCols 빌드 (AoS 병존) ✅ (W18)**: `SiteCols`(32B) Vec를 기존 site_language_ids 패스 확장으로 빌드, RefSite 유지. **별도 38M scan 0**(B1 통찰). 메모리: +32B/site × 38M ≈ 1.2GB peak (16GB 내). 상세 W18 섹션.
- **B3 prefilter → columns ✅ (W18)**: phase_e_prefilter가 `SiteCols`만 읽게(RefSite 0). `*_by_language_and_name`→`(u16,u64)`, `import_*_by_rel` outer→`u64` rekey + self/cls·types·star를 hash로. **격리 측정 win 확인**: paired ×2(고부하) avg 2369→410ms(−83%, 5.8배), 4/4 invariant·after-count 동일. `ZOEK_SOA_B3` gated(default OFF). 상세 W18 섹션.
- **B4 worker → columns ✅ (W19)**: worker가 HEAD(게이트)/TAIL(공유, `site_cols`만) 분리. `add_resolution_count`(`site`→`edge_kind_id`) + `expand_receiver_for_name_cols`/`star_import_candidates_into_cols`/`receiver_resolution_to_cols` + hash-keyed `members_by_container_and_name_h`/`symbols_by_file_and_name_h`/`star_module_hashes_by_rel`. RefSite는 receiver cache-miss서만 fetch. **phase_e −16%(paired)**, invariant 6/6. `ZOEK_SOA_B4` gated. **NameInterner는 불요로 판명**(hash rekey로 충분). 상세 W19 섹션.
- **B5 phase_c → columns ✅ (W20)**: phase_c_process_chunk가 `SiteCols`(48B)만 읽음(boundary서만 rel_path/language string). `symbols_by_name`→`symbol_name_hashes`, may-maps `&str`→`u64`, likely_sites `Vec<&RefSite>`→`Vec<u32>`(offset_from 제거 + `ResolveIntermediate` lifetime 제거). site_cols 빌드 phase_c 앞으로 이동. **phase_c −32%(isolated)/−47%(vs struct)**, invariant 유지. B3/B4와 함께 **default 승격(`ZOEK_SOA_OFF` opt-out)**. 상세 W20 섹션.
- **B6 cold path + RefSite 제거** ← **다음 SoA 진입점**: serialize_ref_site_binary/parse_ref_site_binary/materialize_light_ref가 columns/interner 소비. RefSite AoS retire(struct 경로 + FIXUP 루프 제거, `ZOEK_SOA_OFF` 도 제거). 메모리 −6GB+ 기대. 단 wall 직접 win 작음 → 30s 목표엔 parse(옵션 A)/index(옵션 D)가 우선.
- **B7 reader/query cascade**: shard read 경로 검증. **디스크 포맷은 안 바뀔 수 있음 (SoA는 in-memory만)** → schemaVersion 영향 최소 예상, 단 확인.

### 위험 / 주의
- **메모리 16GB cap**: B2 병존이 peak. interner는 문자열 1회 저장(dedup)이라 net 감소지만 transition 일시 증가 — 단계마다 측정.
- **invariant collision**: name_hash key 충돌은 W9b/W16에서 안전 입증. id 기반은 lossless라 더 안전. enclosing_id_u64/source_ref_id_u64 sentinel(0/u64::MAX, 비-HEX16 fallback) 처리 주의.
- **cascade**: compute_receiver_resolution/expand 시그니처가 B4 핵심 — 한 번에 다 바꾸지 말고 wrapper.
- **측정 환경(W15 교훈)**: captain 종료해야 진짜 idle, 연속 측정 금지(load 누적), background는 절대경로. profile 첫 wall 둘째.

### 다음 세션 첫 명령
1. `optimization.md`의 이 blueprint + W16 섹션 읽기.
2. `git status` (W1~W16 uncommitted 확인) + `cargo build --release` + `cargo test --release --lib`(75/75).
3. **B0**: captain 종료 → idle paired baseline. 그 다음 B1(interner) 착수.

---

### 이전 세션 (W11) — D1c: reference record format 슬림화 (schema 19 → 20)

**먼저 한 일**:
1. baseline 측정 (release, captain2): total=103.9s / 109.7s (load 무거움), stream_references=14.5s / 20.4s, references=14,372,638
2. W10 후 stream_references-only sample 결과를 출발점으로 사용 (CPU-bound, memmove dominant 확정)
3. doc의 D1c 안 직진 — format 슬림화로 byte traffic + disk 동시 감소

- **W11 — `serialize_reference_binary` + `serialize_reference_binary_from_light` + `parse_reference_binary` 슬림 인코딩 통일** ★ 큰 win
  - `serialize_reference_record` 공용 헬퍼로 두 writer를 통합 (graph.rs:9156)
  - record 인코딩 변환 (record당 약 −80B):
    - `source_ref_id` "ref:HEX16" 24B → `u64` 8B (sentinel `u64::MAX` = inline fallback)
    - `target_symbol_id`/`enclosing_symbol_id` "sym:HEX16" 25B → `u64` 9B (0=none, 1=u64, 2=inline)
    - `edge_kind` 6~11B → `u8` 1B (`EDGE_KIND_OTHER=255` = inline)
    - `raw_text == name` marker 1B (대부분의 record가 같음 — 12B 절감)
    - `confidence` → `u8` (CONFIDENCE_OTHER=255 fallback) — 2 variants
    - `provenance` → `u8` (PROVENANCE_OTHER=255 fallback) — 11 variants
  - 새 helpers: `compute_confidence_id`/`confidence_str_from_id`, `compute_provenance_id`/`provenance_str_from_id` (graph.rs:480~)
  - `SCHEMA_VERSION` 19 → 20 (config.rs)
  - indexer 테스트 fixture (schemaVersion 19 → 20)
  - **wall (5 D1c runs vs 2 baseline runs, system load 변동 폭 큼)**:
    - D1c runs: 76.1 / 74.1 / 78.7 / 77.6 / 77.6s — 평균 **76.8s**, range 5s (안정)
    - stream_references: 12.9 / 15.3 / 10.4 / 16.0 / 13.6s — 평균 **13.6s**
    - 동일 세션 baseline (s19): total 106.8s 평균, stream_refs 17.5s 평균 (load 무거운 시간대)
    - **stream_references 진짜 win: 17.5s → 13.6s (−3.9s, −22%)** ← doc 예상 −3~5s 부합
    - total wall 차이의 약 30s는 system load 비대칭 (baseline은 phase_a/d/e도 비정상 elevated)
    - phase_e/phase_c/phase_f 모두 회귀 없음, 다른 phase는 D1c 변경 범위 밖
  - **disk savings (load-invariant clean win)**:
    - 전체 callgraph 디렉토리: **6.1GB → 4.7GB (−1.4GB, −23%)**
    - reference target+enclosing shards 합: **1.06GB** (target 914MB + enclosing 149MB)
  - **추가 reader 검증**: `graph-symbol-query --query main --limit 3` → 9,109 symbols 정상 응답. `graph-symbol-query` 경로는 GraphSymbol shard 직접 read를 거치며 새 SCHEMA_VERSION=20 manifest 통과. (`graph-query --symbol-id` 경로는 무릴 reference shard read를 거치므로 다음 세션에서 별도 round-trip 샘플로 추가 검증 권장)
  - tests 75/75 pass (변경 후 2회 확인), references=14,372,638 invariant 유지 (5/5 runs), schemaVersion=20 확인

**W11 후 추가 진단 후보**:
- D1a (scratch buffer 제거) — D1c가 byte traffic 큰 폭 줄였으나 Stage 1 → Stage 2 2회 copy 패턴 그대로. 추가 −1~2s 가능. 가장 작고 안전한 다음 step
- D1b (per-worker shard writer) — Stage 2 자체 제거. 더 큰 win 가능 (−2~4s)하나 구현 복잡. byte buffer 메모리 추가 필요 (worker × 128 shard × 작은 buffer)
- phase_e (still 16~17s) — 다음 phase별 최대 wall. 옵션 C(sequential per-file) / B(SoA full) 검토 시점
- isolated profiling (stream_references 18s sample) 재실행 권장 — D1c가 memmove leaf samples를 얼마나 줄였는지 확인. 만약 여전히 memmove dominant라면 D1a/D1b가 유효

### 이전 세션 (W10) — phase_c + phase_f 공략

**먼저 한 일**:
1. baseline 측정 (release, captain2): total=90s, stream_references=22.9s, phase_e=17.1s, parse=12.2s, phase_c=6.7s, write_graph_shards=10.3s
2. 측정 안 된 resolve 잔여 추정: 45s−phase 합 35s = **~10s 미지의 phase** 발견
3. profiling binary로 phase_e 종료 후 25s sample → `apply_token_shape_likely_count_baseline` closure가 진짜 #1 active CPU leaf (75K samples)
4. graph.rs:6886에 phase_f의 `HashMap<(&str,&str,&str), V>` 6개 발견 — W9a 동일 패턴

- **W10 — phase_c + phase_f HashMap key `(&str, &str, &str)` → `(u64, u64, u64)`** ★★ 큰 win
  - rebuild path (`resolve_ref_sites_for_rebuild`)에 phase_f probe 추가하여 wall 첫 측정: **phase_f=11.7s** (추정 부합)
  - `ResolveIntermediate`의 6개 `bare_*/member_*_likely_by_scope_and_name` HashMap, `PhaseCAccums`, `phase_c_process_chunk`, `apply_token_shape_likely_count_baseline` 함수 시그니처 + 내부 2개 HashMap (`bare/member_symbol_count_by_scope_and_name`) 모두 변환
  - `name_hash`는 이미 RefSite/GraphSymbol에 precompute됨. `language` & `source_scope_key(rel_path)`는 phase_c_process_chunk와 phase_f process_chunk closure 양쪽에 micro-cache (cached_rel_path/cached_language → cached_scope_hash/cached_lang_hash) — ref_sites/symbols가 file-grouped이라 cache hit rate ~99%
  - struct field 추가 없음 (메모리 추가 0)
  - **wall (3 runs)**:
    - phase_c: 6.5s → 3.4~3.8s (**−41~48%**)
    - phase_f: 11.7s → 4.0~5.4s (**−54~66%**)
    - phase_c+f 합 절감: **−9~11s** (이번 세션 단일 win)
  - **idle total wall: 62.9s** (시스템 load run에서는 79s — stream_references variance가 9s 폭)
  - tests 75/75 pass, references=14,372,638 invariant 유지

**W10 후 추가 진단** (stream_references 18s isolated sample):
- `__psynch_cvwait` 383K (62%) — rayon worker 절반 이상 idle, oversubscription 지속
- **`_platform_memmove` 101K (#1 active CPU leaf)** — `append_lights_to_both_shards`의 Stage 1/2 byte copy
- `_platform_memcmp` 17K + `core::hash::hash_one` 15K
- 커널 `write` syscall: **725 leaf only (0.1%)** — disk write 자체는 무시 가능
- **결론**: stream_references는 **CPU-bound (byte copy bound), not disk-bound**. D1 가설 확정.
  - 14.4M records × ~200B serialize → per-chunk Vec<Vec<u8>> buffer (Stage 1) → per-shard writer (Stage 2). byte copy 2회 (target_id, enclosing_id 동시 emit 시 + 양쪽 chunk buffer로 extend_from_slice).
  - serialize_reference_binary_from_light (graph.rs:9104)이 `write_u16_str` 10회 + 5 fixed-size = record당 ~25 extend_from_slice 호출.

### Write / Disk format
- **sym_uri shard 완전 제거** (sym_id에서 derive; `−820MB`)
- RefSite 인코딩 슬림화:
  - `language` → u8 enum (LANG_UNKNOWN=0 sentinel)
  - `edge_kind` → u8 enum (EDGE_KIND_OTHER=255 fallback)
  - `access_kind` → u8 enum
  - `raw_text == name` marker (1B 대신 string)
  - `source_ref_id` "ref:HEX16" → u64 (8B)
  - `enclosing_symbol_id` "sym:HEX16" → u64
- GraphSymbol 인코딩 슬림화:
  - `id` "sym:HEX16" → u64
  - `kind` → u8 enum
  - `language` → u8 enum (u16 cast)
- count_id shard에서 zero-count 엔트리 skip
- `parallel_sharded_write_serialize` (closure가 buffer를 받음 — 8M Vec alloc/free 제거)
- pre-built `file_table`을 write_store에 전달 (옵션 `precomputed_file_table`)
- **W11 — Reference record 슬림화** (schemaVersion 19 → 20):
  - 공용 헬퍼 `serialize_reference_record` (graph.rs:9156)로 `serialize_reference_binary` (GraphReference) + `serialize_reference_binary_from_light` (LightRef) 두 writer 통합
  - `source_ref_id` "ref:HEX16" → u64 8B (sentinel `u64::MAX` = inline str fallback)
  - `target_symbol_id`/`enclosing_symbol_id` "sym:HEX16" → u64 9B (0=none, 1=u64, 2=inline str). 이전 1+22+2 = 25B → 9B
  - `edge_kind` → u8 (EDGE_KIND_OTHER=255 = inline str). 기존 `compute_edge_kind_id`/`edge_kind_str_from_id` 재사용
  - `raw_text == name` marker (대다수 record가 같아 ~12B 절감)
  - `confidence` → u8 (CONFIDENCE_OTHER=255 fallback) — 2 variants (possible/exact)
  - `provenance` → u8 (PROVENANCE_OTHER=255 fallback) — 11 variants
  - 새 helpers in graph.rs:480~ (access_kind 헬퍼 바로 아래): `compute_confidence_id`, `confidence_str_from_id`, `compute_provenance_id`, `provenance_str_from_id`
  - reader 동기화: `parse_reference_binary` (graph.rs:9915) 완전 재작성 — u8 marker 분기 (target_kind/enclosing_kind 0/1/2, edge/conf/prov 255 fallback)
  - record 평균 ~138B → ~50B (canonical case, raw_text==name 가정)
  - **disk: callgraph 전체 6.1GB → 4.7GB (−23%), reference shards 합 1.06GB**
  - schemaVersion bump: `crates/zoek-rs/src/config.rs` 19 → 20. indexer 테스트 fixture (`src/indexer.rs:1670`) 동기화

### 코드 정리
- 모든 변경 후 75/75 tests 통과 확인됨
- references=14,372,638 invariant 유지
- 직전 세션 (W1-W9b) 추가 lines: ~150줄 add/edit (src/graph.rs)
- 직전 세션 (W10) 추가 lines: ~60줄 add/edit (src/graph.rs)
  - `ResolveIntermediate` 6개 field 타입 변경
  - `PhaseCAccums` type 변경
  - `phase_c_process_chunk` 본문 (micro-cache 추가, key 변경)
  - `apply_token_shape_likely_count_baseline` signature + symbol-count build loop + process_chunk closure key
  - `resolve_ref_sites_for_rebuild`에 `phase_f=` probe 추가
- **이번 세션 (W11) 추가/변경 lines**: 약 +271 / −63 lines across 3 files (`git diff --stat`)
  - `crates/zoek-rs/src/graph.rs` (+250 lines net): `compute_confidence_id`/`confidence_str_from_id`/`compute_provenance_id`/`provenance_str_from_id` 4 helpers, `CONFIDENCE_OTHER`/`PROVENANCE_OTHER` 상수, 공용 `serialize_reference_record` 헬퍼, `serialize_reference_binary` thin wrapper, `serialize_reference_binary_from_light` thin wrapper, `parse_reference_binary` 전체 재작성
  - `crates/zoek-rs/src/config.rs`: `SCHEMA_VERSION` 상수 19 → 20
  - `crates/zoek-rs/src/indexer.rs`: 테스트 fixture 한 줄 19 → 20
- 추가 메모리: `same_file_bare_count` ~35MB, RefSite +24B/site (4개 u64 필드) ≈ 900MB peak (16GB 한계 내). W10/W11는 struct 변경 없음 → 메모리 추가 0.

### W11 변경 사항 검증 절차 (재현용)
```bash
# 1. release rebuild (incremental)
cargo build --release -p zoek-rs --bin zoek-rs

# 2. lib tests (75/75 must pass)
cargo test --release --lib -p zoek-rs

# 3. captain2 full rebuild + invariant check
ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain
# expected output: "schemaVersion":20, "referenceCount":14372638

# 4. (선택) reader round-trip — symbol shard 경로
./target/release/zoek-rs graph-symbol-query /Users/lky/project/captain2/captain --query main --limit 3
# expected: ok=True, symbols list returns
```

---

## 시도했으나 실패한 실험 (다음 세션에서 반복 금지)

### ❌ W12-pool — Rayon pool size sweep (이번 세션)
- **가설**: cvwait 60%는 OS oversubscription (pool=64 vs 물리 코어 15) → pool 줄이면 cvwait 감소 → 다른 phase에 CPU 양보 → multi-phase win 가능
- **시도**: `ZOEK_GRAPH_WORKERS` ∈ {15, 24, 32, 48, 64, 96, 128} 각 1 run (captain2)
- **결과 표** (single run each; load envelope ~3-5s):

  | W | phase_e | stream_refs | parse | total |
  |---|---|---|---|---|
  | **15 (물리)** | **19.0s** | 14.1s | 16.4s | **85.1s (worst)** |
  | 24 | 16.4s | 11.5s | 12.1s | 70.4s |
  | 32 | 15.8s | 10.5s | 11.6s | 68.4s |
  | 48 | 16.3s | 13.7s | 11.3s | 71.6s |
  | **64 (default)** | 14.0s | 11.5s | 11.1s | 65.9s |
  | 96 | 14.2s | 14.3s | 11.1s | 71.8s |
  | **128 (MAX)** | 13.8s | 11.0s | 10.2s | **64.2s** |

- **진짜 진단**: cvwait 60%는 OS oversubscription이 아니라 **HashMap probe의 memory stall 자체**. 물리 코어(15)에서 cvwait 줄어도 phase_e가 가장 느림 — 더 많은 워커가 동시에 probe하면 한 워커가 memory stall인 동안 다른 워커가 CPU 활용. W6 (chunks_per_worker=32 시도)에서 결론 낸 "rayon pool oversubscription"은 부분적으로 맞으나 OS 문제는 아니고 algorithmic memory-bound 패턴이 본질.
- **교훈**: pool=64 default는 거의 optimal. W=128은 −1.7s 추가 win 가능하지만 noise envelope 내. **이미 짠 워커 풀에서 더 짤 거 없음** → 다음 세션에서는 cvwait을 줄이는 시도 금지. 대신 HashMap probe 자체 (memory layout, hot path)를 공략해야 함.
- **부수적 발견**: 오늘 idle total **64-66s** (W11 doc avg 76.8s에서 11s 빠름). D1c 실효 win이 doc 추정보다 컸음 — 이전 측정이 load-affected였던 것이 확인됨.

### ❌ W14 — Writer thread 안에서 `append_lights_to_both_shards` 호출 (이번 세션)
- **가설**: F1.b channel pipeline의 writer가 single-thread 750K records/s로 느림 → batch buffer 누적 후 multi-threaded `append_lights_to_both_shards` 호출하면 rayon par_chunks + par_iter_mut로 14M/16s급 throughput.
- **시도**: `WRITER_FLUSH_THRESHOLD=256K` records, writer thread 안에서 `append_lights_to_both_shards(&drained, ...)` 호출
- **결과**: **rayon nested pool deadlock**. 4분 동안 zoek-rs process 0% CPU. phase E rayon worker들이 channel send block, 그동안 rayon global pool 점유. writer thread가 par_iter spawn 시 worker 못 얻음 → 양쪽 wait
- **교훈**: rayon 글로벌 pool 사용 중인 thread가 또 rayon nested call하면 충돌 가능. **별도 rayon pool (`ThreadPoolBuilder::new().build()`)** 또는 sequential writer로만 안전. 현재 코드는 sequential writer로 회피.

### ❌ W14 — Phase F를 channel send에 통합 (이번 세션)
- **가설**: phase F도 LightRef batch을 channel로 보내면 writer와 추가 overlap → 더 큰 win
- **시도**: `apply_token_shape_likely_count_baseline`에 `light_sender` 전달, F worker가 batch flush 사용
- **결과**: **phase_f wall 4.7s → 17.6s 폭증 (+13s)** — F의 9.2M records가 channel bounded(1024)의 4M records buffer를 빠르게 초과 → worker가 send block 상태에서 writer single-thread가 1.5μs/record로 처리 → 워커 평균 13s wait
- **교훈**: Single-thread writer + bounded queue는 phase F 규모 (9M records / 5s short window)에 미스매치. **Phase F는 Vec 누적 + 메인이 한 batch send로 회피** (현재 구현). channel은 phase E (5M records / 18s long window)에만 효과적.

### ⚠️ W15 — Phase F overlap, W1+W2 writer로 재시도 (이번 세션, 경계선 → 보류)
- **배경**: W14의 두 실패(deadlock·single-writer 한계)를 W1(dedicated rayon pool)+W2(recv/flush 분리 double-buffering)로 해결한 뒤 phase F channel stream 재시도. → **W14의 위 두 ❌ 항목은 W15에서 극복됨.**
- **시도**: `ZOEK_LIGHT_CHANNEL_PHASE_F=1` — `resolve_ref_sites_for_rebuild`가 `apply_token_shape_likely_count_baseline`에 light_sender 전달 (graph.rs:5183). phase F worker가 batch flush + W2 double-buffering writer가 병렬 drain.
- **결과**: phase_f가 W14 single-writer(17.6s 일관 폭증) → W2에서 **6.4s 회복 *가능*하나 간헐 폭증 잔존**(같은 flag로 A1=14.3s / A2=6.4s). `light_out=0` 확인(phase F가 channel 사용). net total은 B(phase F buffered)와 동률 — overlap 이득 거의 없음.
- **원인**: W2 flush thread throughput이 phase F 생성속도(1.5M rec/s)와 경계선. flush가 가끔 못 따라가면 channel 차고 phase F worker가 send에서 stall.
- **교훈**: phase F overlap이 진짜 win 되려면 flush throughput > phase F 생성속도가 *안정적*이어야 함 (writer threads↑ / flush queue↑ 튜닝 필요). 측정 노이즈(captain 31%)로 미검증 → **`ZOEK_LIGHT_CHANNEL_PHASE_F` OFF default 보류.** W2 자체(recv/flush 분리)는 phase E overlap + single-writer 병목 해소에 유효하므로 유지.

### ❌ Parallel write (stream_lights + write_store 동시)
- **결과**: 13.3s sequential → 24s parallel
- **원인**: 둘 다 disk-bound. 같은 disk bandwidth 경쟁 → 각자 2x 느려짐
- **교훈**: 디스크 자원을 경쟁하는 두 작업은 sequential이 최적

### ❌ Pre-write pipeline (resolve와 동시에 static shards 쓰기)
- **결과**: phase_a 2s → 8.5s 회귀 (+6.5s)
- **원인**: 백그라운드 writer thread가 rayon pool + memory bandwidth 점유
- **교훈**: CPU-bound resolve와 disk-bound write를 parallel 실행해도 rayon pool 공유로 인해 충돌

### ❌ SoA precompute (Struct-of-Arrays for ref_sites)
- **시도 1 (4 fields separate Vec)**: site_soa_cache=5248ms 빌드 비용
- **시도 2 (single Vec<SiteHot>)**: 3.7s 빌드, worker 여전히 ref_sites 접근 (string 필드)
- **원인**: Half-measure SoA — worker가 strings (`rel_path`, `name`, `receiver`, `enclosing`)을 위해 여전히 RefSite struct 로드. cache miss 패턴 변하지 않음
- **진정 SoA**: `ref_sites` struct를 완전 제거하고 모든 caller를 site_idx + parallel Vecs로 cascade. 메모리 예산 검토: 16GB cap 위험. **multi-week 프로젝트.**

### ❌ Sort filtered indices by (rel_path, receiver)
- **결과**: sort 자체 6s 추가, phase_e 변화 없음
- **원인**: receiver_cache 히트율 이미 70-90%. sort로 100%로 끌어올려도 cache 친화도 한계
- **교훈**: receiver_cache는 이미 충분히 잘 작동 중

### ❌ Per-language map partition (`bare/member_symbols_by_language`을 array of inner maps)
- **결과**: phase_a +200ms, phase_e 변화 없음
- **원인**: 인덱스 lookup의 cache 친화도 개선 미미. 메모리 총량은 동일

### ❌ `compute_receiver_resolution` 결과 캐시를 더 적극적으로
- 이미 receiver_cache로 처리됨. 추가 적극화 → 캐시 entry 크기 증가, 메모리 한계

### ⚠️ Phase_a 병렬화 (rayon par_chunks + merge)
- **결과**: 2461ms vs 2178ms 단일 thread — 거의 동일
- **원인**: merge 단계가 1.6s 단일 thread (8개 HashMap concat). 병렬 부분의 win을 상쇄
- **교훈**: 병렬 후 single-thread merge는 사라지지 않음. parallel reduce가 필요하나 8 HashMap 동시 reduce 구현이 복잡

### ❌ C2 — `members_by_container_and_name` 2-level map (이번 세션)
- **가설**: 단일 ~28MB map (500K entries)이 L3 boundary → outer 50K + inner small maps로 분할하면 cache 친화도 개선
- **시도**: `HashMap<&str container, HashMap<&str member, Vec<&Sym>>>` 로 refactor
- **결과**: phase_e 변화 없음 (32.7 vs 32.96 median, noise 내)
- **원인**: inner AHashMap 50K개가 별도 heap 할당 → inner probe도 cache miss. doc의 "L3 boundary" 분석은 옳았지만 phase_e cost의 진짜 비중에서 members map probe는 doc 추정보다 작음. profiling으로 확인: 진짜 cost는 string hash + compare (W2로 −71% memcmp 입증)
- **교훈**: 가설 기반 변경 전에 profile로 진짜 hot path 확인. doc의 cost decomposition을 맹신하지 말 것

### ❌ W6 — `chunks_per_worker = 8 → 32` (이번 세션)
- **가설**: W5 후 cvwait이 leaf samples의 60% — 청크 imbalance 같아 보임
- **시도**: phase_e dispatch에서 chunks_per_worker = 32 (옵션 + `ZOEK_PHASE_E_CHUNKS_PER_WORKER` env)
- **결과**: phase_e 변화 없음 (15.6 → 15.8s)
- **원인**: cvwait이 모든 워커에서 균일 ~60% — chunk imbalance가 아니라 **rayon pool=64 vs 물리 코어 수 부족** (OS scheduler thread swap). 워커가 cvwait인 동안 다른 thread가 CPU 사용 중 → wasted CPU 아님
- **교훈**: cvwait이 leaf에 많아도 imbalance만의 신호 아님. 모든 워커 균일 cvwait = OS oversubscription. 추가 chunk granularity로 못 풀음

---

## 진짜 bottleneck 분석 (profiling 기반, 이번 세션 갱신)

### W1+W2+W2c 적용 후 phase_e sample (HEAD 직후, 32s phase_e)

Leaf top-of-stack (active CPU only, excluding cvwait):
- 워커 closure: 528K samples (73% of useful CPU)
- **memcmp**: 35.7K, **memmove**: 28K, **memchr**: 21K → 합 **85K (12%)**
- hash_one 4 variants 합: **57K (8%)**
- 결론: **string hash + compare가 phase_e의 ~20%**, 명백한 1차 타겟. cache miss는 doc 추정보다 비중 작음

핵심 hot line:
- **5462 (309K samples)**: `same_file_count = fallback_candidates.iter().filter(|symbol| symbol.rel_path == site.rel_path.as_str()).count()` — 일부 흔한 이름이 1000+ candidates → 1000+ memcmp per site
- 5323 (94K): receiver_cache miss 경로
- 5348 (47K): fallback_buf.extend (bare path)
- 5591-5594 (45K): dead materialize loop ← W1으로 제거

### W5 적용 후 sample (15.6s phase_e, 더 깊은 진단)

Leaf top-of-stack:
- **__psynch_cvwait 174K** — 새 #1, 워커 균일 idle (rayon pool oversubscription)
- 워커 closure: 162K (60% 감소)
- hash_one 4 variants: 33K
- memcmp: 11K (W2로 35.7K → 10.4K → 11K, 안정)
- HashMap::get: 5.5K

새 hot lines:
- 5363 (60K): `receiver_cache.entry(key).or_insert_with(...)` — 3-string key hash + probe
- 5388 (26K): `fallback_buf.extend(bare.iter().copied())` — bare 후보 copy
- 5347 (21K): `if site.is_definition` — RefSite struct cold load

### W9 적용 후 sample (current, 16-17s phase_e)

- closure leaf: 162K → 94K (−42%)
- memcmp: 11K → 5K (−55%)
- 활성 작업이 더 줄었지만 phase_e wall 측정은 system noise 폭 안 (1-run 기준 17s, idle 측정 필요)

### W10 진입 직전 sample (90s load run, phase_e 종료 직후 25s sample)

phase_e+phase_f+stream_references 일부 cover. Leaf top-of-stack:
- `__psynch_cvwait`: 558K (rayon worker idle, oversubscription)
- **`apply_token_shape_likely_count_baseline` closure: 75K** ← 진짜 #1 active CPU
- _platform_memmove: 70K, _platform_memcmp: 47K → 3-string-tuple hash/compare 비용
- hash_one variants 4종 합: 23K
- site_partial_hash: 15K
- HashMap::get/insert: 8.8K

**진단**: phase_f가 doc에 없던 ~10s phase. 그곳의 `HashMap<(&str,&str,&str), V>` 6개가 phase_c+phase_f hot path. W9a 패턴 그대로 적용 → W10.

**W10는 struct field 추가 없이 (메모리 0) micro-cache + tuple key 변환으로 phase_c+phase_f 합계 −9~11s.**

### W10 직후 stream_references-only sample (76s load run, phase_f 종료 직후 18s sample)

```
__psynch_cvwait                         383680   (rayon idle, 62%)
rayon::bridge_producer_consumer         103927   (worker plumbing, 17%)
_platform_memmove                       101270   ← #1 active CPU (16%)
_platform_memcmp                         17539
core::hash::BuildHasher::hash_one        15400
zoek_rs::graph::rebuild_graph_native      2578
zoek_rs::graph::serialize_symbol_binary   1527
write (kernel syscall)                     725   (disk = 0.1%)
zoek_rs::graph::FileTable::intern          207
zoek_rs::graph::write_str_list              82
zoek_rs::graph::compute_language_id         58
```

**진단**:
- stream_references는 **CPU-bound, not disk-bound** (kernel `write` < 0.2%).
- 진짜 CPU work: memmove + memcmp + hash = 133K leaf samples. 대부분 `append_lights_to_both_shards`의 byte copy.
- worker cvwait 62%는 oversubscription (rayon pool=64 vs 물리 코어). W6 결과처럼 chunk granularity로 해결 안 됨.

**Stage 1/2 비효율 패턴**:
- record당 byte 흐름: scratch Vec → tgt_bufs[s] (target 있을 때) → enc_bufs[s] (enclosing 있을 때) → 최종 shard writer
- 대부분 records가 target+enclosing 모두 있어 scratch → 2개 chunk buffer로 byte copy 2회, 그 다음 stage 2가 chunk buffer → shard writer로 1회 더 copy
- record 평균 ~200B × 14.4M records × ~3회 copy ≈ 8GB byte traffic
- 추가로 `serialize_reference_binary_from_light` 내부의 ~25 extend_from_slice 호출

**다음 step 후보 (D1)**:
1. **Stage 2 통합** — chunk buffer를 결합한 후 한 번에 write (Stage 1 byte traffic 그대로지만 Stage 2 copy 제거)
2. **per-worker shard writer** — 각 worker가 자신의 per-shard byte buffer 가짐 → 최종 단계만 file write. Stage 2 사라짐.
3. **per-shard direct serialize** — scratch 제거. target에 직접 serialize, enclosing 있으면 추가로 enc buffer에 동일 bytes 복사 (1회 copy)
4. **Format 슬림화** (schemaVersion bump) — confidence/provenance 등 string → enum u8. record 평균 ~200B → ~120B. byte traffic 40% 절감.

---

## 다음 세션 권장 옵션 (W11 후 갱신)

> **참고용 (W11판 분석).** 방향은 W16에서 **옵션 B (SoA)** 로 확정됨 → 실행 계획은 위 `## 🎯 옵션 B blueprint`. 아래 옵션 A/C/D는 옵션 B 이후의 후보로 보존.

### W11 후 phase 분포 (load-중간 76.8s 평균; idle 추정치는 W10 idle 62.9s 대비 D1c 차이만큼 추가 절감 기대)

| Phase | wall (W11 5-run 평균) | 비중 |
|---|---|---|
| phase_e | 16.8s | **22%** ★ 단일 최대 (이전 stream_refs 자리) |
| stream_references | 13.6s | 18% (W10 대비 −22% 평균) |
| parse | 12.3s | 16% |
| write_graph_shards | ~8s | 10% |
| phase_f | 6.2s | 8% |
| phase_c | 4.9s | 6% |
| phase_a | 2.2s | 3% |
| phase_e_prefilter | 2.4s | 3% |
| phase_d | 2.0s | 3% |
| discover | 2.2s | 3% |
| phase_b | 1.3s | 2% |

**관전 포인트**: W11 이후 stream_references와 phase_e가 거의 동률. phase_e가 약간 더 큼 → 다음 phase별 1차 타겟이 phase_e로 이동했을 가능성.

### 옵션 D — stream_references 잔여 공략 (D1a/D1b)
**근거**: D1c (W11)로 stream_references record byte size −80B/record. Stage 1/2 copy 구조 자체는 그대로 → 추가 win 여지 있음. byte traffic이 줄어든 만큼 D1a/D1b의 효과도 비례 감소했을 가능성. 진입 전 isolated profile 한 번 더 확인 권장.

**남은 서브 옵션** — `append_lights_to_both_shards` (graph.rs:7917) 공략:
- **D1a — scratch 제거 (1-2시간, 안전)**: Stage 1에서 scratch buffer 제거. target_id가 있으면 tgt_bufs[s]에 직접 serialize → enclosing_id 있으면 같은 record bytes를 enc_bufs[es]에 복사. byte copy 2회 → 1.5회. 예상 −1~2s.
- **D1b — per-worker shard writer (반나절)**: 각 worker가 자신의 per-shard byte buffer 보유 (worker × 128 shards × small buffers). 마지막 단계만 byte writer로 flush. Stage 2의 별도 par_iter_mut copy 제거. 예상 −2~4s.
- ~~**D1c — Format 슬림화**~~ ✅ **W11에서 완료** (schema 19→20, stream_references −3.9s, disk −1.4GB)
- **D2**: parse 단계 (12.3s, 16%) — tree-sitter call이 진짜 CPU bottleneck이면 custom tokenizer 검토 (옵션 A 참고)
- **D3**: `compute_native_counts` 후속 + index 결합

**권장 순서**: D1a (작고 안전) → D1b (중간). 단, phase_e(16.8s)가 stream_references(13.6s)보다 커진 상태이므로 phase_e 공략(옵션 C/B)도 동등 우선순위

### 옵션 C — Sequential per-file resolve (2-4주)
**핵심 아이디어**: phase_e를 파일 단위 batch로 재구성. 단 W5+W9 이후 phase_e가 16s 수준이라 단독 큰 win은 제한적

- ref_sites를 file-grouped 구조로 reorganize (parse 단계 또는 resolve 입구)
- 각 파일 처리 시:
  1. 이 파일의 mini-context 빌드: 이 파일이 참조 가능한 imports/types/members만 (글로벌 dataset의 subset)
  2. 파일 내 sites 처리
  3. mini-context 폐기, counts/lights는 글로벌로 누적
- 글로벌 `members_by_container_and_name`는 **container_name 일차 lookup으로만 축소**

**예상 효과**: phase_e 16s → 10~12s

**작업 범위**: `resolve_ref_sites_a_to_e` 재작성, `compute_receiver_resolution` / `expand_receiver_for_name` 시그니처 변경

**위험**: 정확도 회귀 가능성. captain2 references==14,372,638 게이트

### 옵션 A — Custom tokenizer + native parse (2-3주)
> **⚠️ W21 정정: 전제가 틀렸다 — 이 코드베이스엔 tree-sitter가 없다**(Cargo.toml 무의존, parse는 이미 `extract_*` hand-written regex/string). "tree-sitter 교체"는 해당 없음. 아래는 무시하고, parse 공략은 **기존 추출 함수 최적화**(W21 P1/P2 + 남은 스캔/IO/malloc)로 본다. parse sub-phase 분해는 `ZOEK_PARSE_PROFILE=1`.

**(원래 서술, 폐기)** ~~핵심 아이디어: tree-sitter 호출을 hand-written tokenizer로 교체~~

- ~~언어별 (Python, JavaScript, TypeScript, Java 등) 토크나이저~~
- ~~identifier extraction + import detection 핵심 기능만~~
- ~~tree-sitter output과 dual-check로 검증~~

**W21 후 실제 parse 공략 경로**: ref_sites(46%)/symbol_defs(20%)/type_facts(18%)의 잔여 비용 = ① 스캔(`sanitize`/`identifier_tokens`/`member_receiver_name`/`StrSearcher`·`str::find`) ② file I/O(135K 파일 open/read/close ~16%) ③ malloc 경합(128스레드). type_facts는 sparse한데 전 라인 sanitize → fast pre-check로 skip 여지. **위험: 추출 로직 변경은 정확도 회귀** → 게이트에 `referenceCount`+`symbolCount`+**`bytes`** 3종(W21 버그 교훈).

### 옵션 B — RefSite full SoA + string interning (3-5주)
**핵심 아이디어**: `Vec<RefSite>`를 SoA `RefSitesColumns`로 대체

- 모든 string 필드를 u32 ID (per-rel_path interner, per-name interner)
- 메모리 16B/site × 38M = 600MB (현재 7.6GB 대비 −92%)
- worker는 dense u32/u16/u8 columns만 읽음 → L1/L2 cache 친화적

**예상 효과**: phase_e 16s → 5~10s, 메모리 절감 6.5GB+

**작업 범위 (가장 큼)**: RefSite struct를 retire하거나 SerializeOnly 형태로, 모든 caller 재작성, Reader 코드 cascade, String interner thread-safe 설계

**위험**: 매우 큰 cascade. 모든 read/write/query 코드 영향.

---

## 다음 세션 시작 시 첫 단계

> **이 섹션은 W15판 구 가이드 — 현재 진입점은 맨 위 `▶ START HERE` + 중간 `## 🎯 옵션 B blueprint`.** 방향이 옵션 B(SoA)로 확정됐고 channel 미결정도 해소됨(ON). 아래는 여전히 유효한 **측정 환경 주의 + 과거 학습**만 보존.

**측정 환경 주의 (W15 최대 교훈 — 옵션 B 측정에도 그대로 적용)**:
- captain VSCode workspace의 python ~14개가 **~31% CPU 상수** 점유 + 가끔 `django-erd-ogdf-layout` 100% → phase_e 변동(idle 14s ↔ 부하 22~35s). 진짜 idle은 **captain 완전 종료** 필요.
- **연속 측정 금지**: graph-rebuild(128 worker)가 load avg를 누적 → run 사이 idle 대기(load1<3.5~5) 필수. 스크립트: `/tmp/zoek_paired3.sh`, `/tmp/zoek_chan.sh` (절대경로 + wait_idle).
- **`/bin/zsh` background 실행 시 `export PATH` 미적용** → 외부 명령은 **절대경로** (`/usr/bin/uptime`, `/bin/sleep`, `/usr/bin/grep` …). foreground Bash는 PATH 정상.
- **profile 첫, wall 둘째** (profile은 active-CPU만 봐서 load robust; wall은 단일 run 신뢰 금물, phase-단위 비교가 최선).
- 매 step: `cargo test --release --lib` 75/75 + captain2 `references==14,372,638` + schemaVersion=20 게이트.

**W15 (W1+W2) 학습 사항** (다음 세션 진입 시 인지):
- **dedicated rayon pool** (`ThreadPoolBuilder::build()` + `pool.install`)로 writer를 multi-thread화 → global pool(phase E worker가 send block 중 점유)과 분리되어 W14 nested deadlock 회피. `append_lights_to_both_shards`는 `rayon::current_num_threads()`로 청크.
- **recv/flush 분리(double-buffering, `std::thread::scope` nested + bounded(3) queue)**로 writer 내부 직렬 병목 해소 — recv가 flush에 안 막혀 channel 계속 비움. W1(recv+flush 동일 thread)의 "flush 중 channel 참 → phase F stall" 해결.
- **phase F overlap은 여전히 보류**: W2로 backpressure 완화되나 flush가 phase F 생성속도(1.5M rec/s)와 경계선 → 간헐 폭증(phase_f 6.4↔14.3s). 진짜 win 되려면 flush throughput을 phase F 위로 (writer threads↑/flush queue↑ 튜닝) — 측정 노이즈로 미검증. `ZOEK_LIGHT_CHANNEL_PHASE_F` flag OFF default.
- **channel net win 0의 근본 원인**: phase E(36%)만 overlap, phase F(64% = 9.18M)는 resolve 후 drain. index −11s를 writer drain이 도로 씀.

**W13 (F1.a)에서 확실히 효과 본 것 (유지)**:
- phase_f rescan 루프 제거, F의 lights 의존도 0, `light_target_count_by_id_u64` tally hook.

**~~W12 후 미해결 회귀~~ → 해소 (W16 확인)**:
- `partial_hash` precompute on RefSite — **이미 revert된 상태**였음 (W16 grep: `partial_hash` 필드 없음, `site_partial_hash(...)` 호출만 3곳 잔존). 추가 조치 불요. site_partial_hash(phase_e 20K samples)는 source_ref_id+edge_kind 정수화로 줄일 수 있으나 38M parse-precompute 함정이라 보류 (옵션 B에서 source_ref_id_u64 column으로 자연 해결).

---

## Reference: 측정 command

```bash
# === W15 측정 주의 (반드시 인지) ===
# - 연속 측정 금지: graph-rebuild 128 worker가 load avg를 누적 → 측정마다 load 폭증으로 보임.
#   run 사이 wait_idle(load1<5) 필수. (검증 스크립트 패턴: /tmp/zoek_paired3.sh)
# - /bin/zsh background 실행은 export PATH 미적용 → 외부 명령은 절대경로 (/usr/bin/uptime, /bin/sleep, /usr/bin/grep …).
# - 진짜 idle은 captain VSCode 종료: python 14개 ~31% CPU가 phase_e 15~22s 변동의 주원인.

# clean baseline measurement (W15: default channel pipeline ON; ZOEK_DISABLE_LIGHT_CHANNEL=1 로 fallback)
ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain

# F1.b channel pipeline OFF (fallback path)
ZOEK_DISABLE_LIGHT_CHANNEL=1 ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain

# F1.b channel queue capacity tuning (default 1024 batches × 4096 records ≈ 96MB)
ZOEK_LIGHT_CHANNEL_CAP=2048 ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain

# with write probe
ZOEK_WRITE_PROBE=1 ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain

# tests
cargo test --release --lib

# profiling build + sample (macOS)
cargo build --profile profiling -p zoek-rs --bin zoek-rs
# In one shell session:
ZOEK_RESOLVE_PROBE=1 ./target/profiling/zoek-rs graph-rebuild /Users/lky/project/captain2/captain > /tmp/zoek_run.log 2>&1 &
ZPID=$!
# phase_e sample (W9 후 ~16s wall):
until grep -q "phase_e_prefilter=" /tmp/zoek_run.log; do sleep 1; done
sample $ZPID 20 -file /tmp/phase_e_sample.txt
wait $ZPID

# stream_references isolated sample (W10 후 phase_f probe 사용; ~18s wall):
ZOEK_RESOLVE_PROBE=1 ./target/profiling/zoek-rs graph-rebuild /Users/lky/project/captain2/captain > /tmp/zoek_run.log 2>&1 &
ZPID=$!
until grep -q "phase_f=" /tmp/zoek_run.log; do sleep 1; done
sample $ZPID 18 -file /tmp/stream_refs_sample.txt
wait $ZPID

# hot line analysis (replace with closure name from sample report)
grep -E "resolve_ref_sites_a_to_e::_.+closure.+graph.rs:[0-9]+" /tmp/phase_e_sample.txt | \
  perl -nE 'if (/(\d+) zoek_rs::graph::resolve_ref_sites_a_to_e.+graph\.rs:(\d+)/) { $h{$2} += $1 } END { for $k (sort {$h{$b}<=>$h{$a}} keys %h) { say "$h{$k}\tgraph.rs:$k" } }' | head -20

# leaf top-of-stack (true CPU spending)
sed -n "$(grep -n '^Sort by top of stack' /tmp/phase_e_sample.txt | head -1 | cut -d: -f1),+50p" /tmp/phase_e_sample.txt
```

## Reference: 핵심 파일

- `src/graph.rs` (~12,400 lines): 모든 resolve/write 로직
- `src/bin/zoek-rs.rs`: CLI 진입점
- 변경 집중 지역:
  - `resolve_ref_sites_a_to_e` (line ~4960+): phase A-E
  - phase_e worker loop (line ~5330+): 가장 hot
  - `compute_receiver_resolution` / `expand_receiver_for_name` (line ~6050+)
  - `extend_and_collect_members_for_type` / `members_by_container_and_name` (line ~6620+)
  - `serialize_ref_site_binary` / `serialize_symbol_binary` (line ~9220+)
  - `write_graph_shards` (line ~7920+)
- `Cargo.toml`: `[profile.profiling]` (W9 측정용, line-tables-only debug info)

## Reference: 시스템 noise

같은 코드도 run-to-run에 wall 변동:
- best clean: 62.9s (W10 idle r2 측정), ~75-80s typical (W10 load)
- W11 (D1c 후) 5 runs: 74.1~78.7s (load 중간), 평균 76.8s — idle 추정 ~60-65s
- typical: 75~95s
- system-load heavy: 100~130s
- stream_references 단독 run-to-run variance: W11에서도 10.4~16.0s (5.6s 폭). single run 신뢰 금물

측정 시 시스템 idle 상태 + 2-5 runs 권장. 단일 measure를 절대 신뢰하지 말 것.

**Profile 첫, wall 측정 둘째**: profile은 system load에 robust (활성 CPU samples만 봄). wall은 system load 변동에 민감. 한 step의 효과를 빠르게 검증할 땐 profile diff가 단일 wall 측정보다 신뢰도 높음.

**Phase-단위 비교가 가장 신뢰도 높음**: total wall은 stream_references의 9s 변동(12.8~21.8s 관측)에 좌우되지만 phase_c / phase_f 같은 CPU-bound phase는 변동 폭이 작아 변경 효과를 직접 비교 가능. W10 검증도 phase_c+f 합 비교로 결론 냄 (run-to-run 일관, 9~11s 절감).
