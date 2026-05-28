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

## 현재 best state (W10 세션 후)

| 측정 | 원본 추정 | 직전 best | 현재 best | 절감 (누적) |
|---|---|---|---|---|
| **Total wall** | 100~118s | ~80s (load) | **62.9s (idle r2) / 79.0s (load r1)** | **−47% (idle)** |
| **phase_e** | ~30s | 15.6s | 13.5~15s | **−50%** |
| **phase_c** | — | 6.5s | **3.4~3.8s** (W10) | **−45%** |
| **phase_f** | — (측정 안 됨) | 11.7s (probe 추가 직후) | **4.0~5.4s** (W10) | **−54%** |
| Disk bytes | 7.27GB | 3.79GB | 3.79GB | −48% |
| write-probe wall | 14.2s | 5.3s | ~10s (load) | mixed |
| stream_references | — | 17~21s | 12.8~21.8s (load 변동 큼) | unchanged |

Sub-phase 분해 (W10 idle 62.9s 기준):
- discover: 1.8s
- parse: 10.1s (tree-sitter, CPU-bound, 64 rayon workers)
- resolve: 29.6s (phase_a 2.4 + phase_b 0.9 + phase_c 3.4 + phase_d 1.8 + prefilter 1.6 + phase_e 13.5 + phase_f 4.0 + misc)
- index: 21.3s (12.8s stream_references + 8.5s write_graph_shards)

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

### 이번 세션 (W1, W2, W2c, W5, W9a, W9b)

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

- **W10 — phase_c + phase_f HashMap key `(&str, &str, &str)` → `(u64, u64, u64)`** ★★ 큰 win
  - profiling-driven (`sample` PID DURATION) — phase_e 직후 25s sample 결과 `apply_token_shape_likely_count_baseline` closure가 진짜 #1 active CPU leaf (75K samples, doc 미언급 영역)
  - rebuild path에 phase_f probe 추가하여 wall 첫 측정: **phase_f=11.7s** (resolve 잔여 ~10s 추정 부합)
  - `ResolveIntermediate`의 6개 `bare_*/member_*_by_scope_and_name` HashMap, `PhaseCAccums`, `phase_c_process_chunk`, `apply_token_shape_likely_count_baseline` 함수 시그니처 + 내부 2개 HashMap (`bare/member_symbol_count_by_scope_and_name`) 모두 변환
  - `name_hash`는 이미 RefSite/GraphSymbol에 precompute됨. `language` & `source_scope_key(rel_path)`는 micro-cache (cached_rel_path/cached_language → cached_scope_hash/cached_lang_hash) — ref_sites/symbols가 file-grouped이라 cache hit rate ~99%
  - struct field 추가 없음 (메모리 추가 0)
  - **wall**:
    - phase_c: 6.5s → 3.4~3.8s (**−41~48%**)
    - phase_f: 11.7s → 4.0~5.4s (**−54~66%**)
    - phase_c+f 합 절감: **−9~11s** (가장 큰 단일 win)
  - **idle total wall: 62.9s** (시스템 load run에서는 79s — stream_references variance가 9s 폭)
  - tests 75/75 pass, references=14,372,638 invariant 유지

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

### 코드 정리
- 모든 변경 후 75/75 tests 통과 확인됨
- references=14,372,638 invariant 유지
- 이번 세션 (W9까지) 추가 lines: ~150줄 add/edit (src/graph.rs)
- W10 추가 lines: ~60줄 add/edit (src/graph.rs; struct 변경 없음)
- 추가 메모리: `same_file_bare_count` ~35MB, RefSite +24B/site (4개 u64 필드) ≈ 900MB peak (16GB 한계 내). W10는 메모리 추가 0.

---

## 시도했으나 실패한 실험 (다음 세션에서 반복 금지)

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

---

## 다음 세션 권장 옵션 (W10 후 갱신)

### W10 후 phase 분포 (idle 62.9s 기준)

| Phase | wall | 비중 |
|---|---|---|
| stream_references | 12.8~21.8s | **~20~35%** ★ 최대 |
| phase_e | 13.5s | 21% |
| parse | 10.1s | 16% |
| write_graph_shards | 8.5s | 13% |
| phase_f (W10) | 4.0s | 6% |
| phase_c | 3.4s | 5% |
| phase_a | 2.4s | 4% |
| phase_d | 1.8s | 3% |
| discover | 1.8s | 3% |
| phase_e_prefilter | 1.6s | 3% |
| phase_b | 0.9s | 1% |

### 옵션 D — stream_references 공략 (★ 추천, 1-2주 D1 sub-target)
**근거**: W10 후 stream_references가 단일 최대 wall (20~35%, system load 변동 크지만 일관되게 가장 큼). phase_e보다 큼.

**서브 옵션**:
- **D1** (★ 다음): stream_references CPU vs disk 분리 sample. `append_lights_to_both_shards`의 Stage 1 (rayon serialize 14.4M records into per-shard buffers) vs Stage 2 (per-shard parallel write) 각각의 시간 비교. Stage 1이 큰 비중이면 serialize 최적화 (string→u32 fields가 가장 큰 차이) / Stage 2가 크면 IO 자체 한계 → buffer 크기 / write coalescing 검토.
- **D2**: parse 단계 — tree-sitter call이 진짜 CPU bottleneck이면 custom tokenizer 검토 (옵션 A 참고)
- **D3**: `compute_native_counts` 후속 + index 결합

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
**핵심 아이디어**: tree-sitter 호출을 hand-written tokenizer로 교체

- 언어별 (Python, JavaScript, TypeScript, Java 등) 토크나이저
- identifier extraction + import detection 핵심 기능만
- tree-sitter output과 dual-check로 검증 (개발 중)

**예상 효과**: parse 11s → 3~5s (60% 절감)

**위험**: 정확도 회귀 — Python decorators, JS arrow functions, generic syntax 등 edge case. dual-check 필수.

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

1. `optimization.md` 읽고 이전 시도 + W1-W9 누적 변경 확인
2. `git status` / `git log -10` 로 commit 상태 확인 (이번 세션 변경 commit 후 새 branch 권장)
3. captain2에서 baseline 측정 (clean system 필요)
4. profile **먼저**: `./target/profiling/zoek-rs` 빌드 후 macOS `sample` 또는 samply로 hot path 재확인 — 옵션 D/C/A 결정 근거
5. 결정된 옵션 진행, 매 step 후 `cargo test --release --lib` (75/75) + captain2 references==14,372,638 게이트

---

## Reference: 측정 command

```bash
# clean baseline measurement
ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain

# with write probe
ZOEK_WRITE_PROBE=1 ZOEK_RESOLVE_PROBE=1 ./target/release/zoek-rs graph-rebuild /Users/lky/project/captain2/captain

# tests
cargo test --release --lib

# profiling build + sample (macOS)
cargo build --profile profiling -p zoek-rs --bin zoek-rs
# In one shell session:
ZOEK_RESOLVE_PROBE=1 ./target/profiling/zoek-rs graph-rebuild /Users/lky/project/captain2/captain > /tmp/zoek_run.log 2>&1 &
ZPID=$!
until grep -q "phase_e_prefilter=" /tmp/zoek_run.log; do sleep 1; done
sample $ZPID 20 -file /tmp/phase_e_sample.txt   # samples phase_e
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
- best clean: 61~62s (원본 doc), ~50s 추정 (W9 후)
- typical: 75~95s
- system-load heavy: 100~130s

측정 시 시스템 idle 상태 + 1-2 runs 권장. 단일 measure를 절대 신뢰하지 말 것.

**Profile 첫, wall 측정 둘째**: profile은 system load에 robust (활성 CPU samples만 봄). wall은 system load 변동에 민감. 한 step의 효과를 빠르게 검증할 땐 profile diff가 단일 wall 측정보다 신뢰도 높음.
