// P1-B portable fall core implementation: tracking + posture + temporal fall state machine.
#include "fall_core.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <cstdio>

namespace p1b {

const char* posture_name(Posture p)
{
    switch (p)
    {
    case Posture::NO_PERSON: return "NO_PERSON";
    case Posture::UPRIGHT: return "UPRIGHT";
    case Posture::SITTING_OR_CROUCHING: return "SITTING_OR_CROUCHING";
    case Posture::HORIZONTAL: return "HORIZONTAL";
    case Posture::TRANSITION: return "TRANSITION";
    default: return "UNKNOWN";
    }
}

const char* fall_state_name(FallState s)
{
    switch (s)
    {
    case FallState::MONITORING: return "MONITORING";
    case FallState::DESCENT_CANDIDATE: return "DESCENT_CANDIDATE";
    case FallState::HORIZONTAL_CANDIDATE: return "HORIZONTAL_CANDIDATE";
    case FallState::PERSISTENT_HORIZONTAL: return "PERSISTENT_HORIZONTAL";
    case FallState::FALL_CONFIRMED: return "FALL_CONFIRMED";
    default: return "UNKNOWN";
    }
}

static float clampf(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

static float iou_xywh(float ax, float ay, float aw, float ah, float bx, float by, float bw, float bh)
{
    float ax2 = ax + aw, ay2 = ay + ah;
    float bx2 = bx + bw, by2 = by + bh;
    float ix1 = std::max(ax, bx), iy1 = std::max(ay, by);
    float ix2 = std::min(ax2, bx2), iy2 = std::min(ay2, by2);
    float iw = std::max(0.f, ix2 - ix1), ih = std::max(0.f, iy2 - iy1);
    float inter = iw * ih;
    float uni = aw * ah + bw * bh - inter;
    return uni > 0.f ? inter / uni : 0.f;
}

static bool midpoint(const Kpt& a, const Kpt& b, float thr, float* x, float* y)
{
    bool va = a.conf >= thr;
    bool vb = b.conf >= thr;
    if (va && vb)
    {
        *x = 0.5f * (a.x + b.x);
        *y = 0.5f * (a.y + b.y);
        return true;
    }
    if (va)
    {
        *x = a.x;
        *y = a.y;
        return true;
    }
    if (vb)
    {
        *x = b.x;
        *y = b.y;
        return true;
    }
    return false;
}

FallEngine::FallEngine(FallConfig cfg) : cfg_(cfg) {}

void FallEngine::reset_state()
{
    tracks_.clear();
    primary_id_.clear();
    history_.clear();
    next_track_id_ = 1;
    next_event_seq_ = 1;
    state_ = FallState::MONITORING;
    state_since_ms_ = 0;
    descent_start_ms_ = 0;
    horizontal_start_ms_ = 0;
    last_valid_ms_ = 0;
    have_last_valid_ = false;
    active_event_id_.clear();
    last_event_id_.clear();
    active_event_ = false;
    recovered_flag_ = false;
    last_primary_matched_ = false;
    primary_last_seen_ms_ = 0;
    have_standing_baseline_ = false;
    standing_baseline_ms_ = 0;
    baseline_hip_norm_ = baseline_shoulder_norm_ = baseline_bbox_h_norm_ = 0.f;
    have_last_norms_ = false;
    peak_hip_v_ = peak_shoulder_v_ = 0.f;
    collapse_since_ms_ = 0;
}

void FallEngine::add_reason(FallDecision& d, const std::string& code) const
{
    if (std::find(d.reason_codes.begin(), d.reason_codes.end(), code) == d.reason_codes.end())
    {
        d.reason_codes.push_back(code);
    }
}

FallEngine::Track* FallEngine::find_track(const std::string& id)
{
    for (size_t i = 0; i < tracks_.size(); i++)
    {
        if (tracks_[i].id == id) return &tracks_[i];
    }
    return NULL;
}

const FallEngine::Track* FallEngine::find_track(const std::string& id) const
{
    for (size_t i = 0; i < tracks_.size(); i++)
    {
        if (tracks_[i].id == id) return &tracks_[i];
    }
    return NULL;
}

void FallEngine::prune_tracks(int64_t now)
{
    std::vector<Track> kept;
    for (size_t i = 0; i < tracks_.size(); i++)
    {
        if (now - tracks_[i].last_seen_ms <= (int64_t)cfg_.track_remove_ms)
        {
            kept.push_back(tracks_[i]);
        }
    }
    tracks_.swap(kept);
}

std::string FallEngine::next_event_id(const std::string& track_id)
{
    char buf[96];
    snprintf(buf, sizeof(buf), "p1b-%s-%llu", track_id.empty() ? "unknown" : track_id.c_str(),
             (unsigned long long)next_event_seq_++);
    return std::string(buf);
}

void FallEngine::push_history(int64_t now, float hip_y_norm)
{
    HistorySample hs; hs.t_ms = now; hs.hip_y_norm = hip_y_norm; history_.push_back(hs);
    const int64_t keep_ms = 2000;
    while (!history_.empty() && now - history_.front().t_ms > keep_ms) history_.erase(history_.begin());
}

float FallEngine::compute_descent_velocity(int64_t now, float hip_y_norm, float* drop_out) const
{
    *drop_out = 0.f;
    if (history_.empty()) return 0.f;
    // Pick the sample whose age is closest to the configured window (requires dt >= 150 ms).
    const HistorySample* best = NULL;
    int64_t best_diff = 0;
    for (size_t i = 0; i < history_.size(); i++)
    {
        const HistorySample& s = history_[i];
        if (s.t_ms >= now) continue;
        int64_t dt = now - s.t_ms;
        if (dt < 150) continue;
        int64_t diff = std::llabs(dt - (int64_t)cfg_.descent_window_ms);
        diff = std::llabs(dt - (int64_t)cfg_.descent_window_ms);
        if (!best || diff < best_diff)
        {
            best = &s;
            best_diff = diff;
        }
    }
    if (!best) return 0.f;
    int64_t dt = now - best->t_ms;
    float dy = hip_y_norm - best->hip_y_norm;
    *drop_out = dy;
    if (dy <= 0.f) return 0.f;
    return dy * 1000.f / (float)dt;
}

FallEngine::PostureInfo FallEngine::evaluate_posture(const PersonObs& p, int img_w, int img_h) const
{
    PostureInfo pi;
    pi.aspect = p.w / std::max(1.f, p.h);
    pi.kpt_avg = 0.f;
    pi.kpt_min = 1.f;
    for (int i = 0; i < kNumKpts; i++)
    {
        const float c = p.kpts[i].conf;
        if (c >= cfg_.kpt_conf_min) pi.valid_kpts++;
        pi.kpt_avg += c;
        pi.kpt_min = std::min(pi.kpt_min, c);
    }
    pi.kpt_avg /= (float)kNumKpts;
    if (pi.valid_kpts < cfg_.min_valid_kpts)
    {
        pi.ok = false;
        pi.posture = Posture::UNKNOWN;
        pi.reason = "KPT_INSUFFICIENT";
        return pi;
    }

    float shx = 0.f, shy = 0.f, hx = 0.f, hy = 0.f;
    bool shoulders = midpoint(p.kpts[5], p.kpts[6], cfg_.kpt_conf_min, &shx, &shy);
    bool hips = midpoint(p.kpts[11], p.kpts[12], cfg_.kpt_conf_min, &hx, &hy);
    if (!shoulders || !hips)
    {
        pi.ok = false;
        pi.posture = Posture::UNKNOWN;
        pi.reason = "TORSO_KPT_MISSING";
        return pi;
    }
    pi.hip_valid = true;
    pi.hip_y = hy;
    pi.hip_y_norm = img_h > 0 ? clampf(hy / (float)img_h, -0.5f, 1.5f) : 0.f;
    pi.torso_valid = true;
    float dx = shx - hx;
    float dy = shy - hy;
    pi.torso_angle = (float)(std::atan2(std::fabs(dx), std::fabs(dy)) * 180.0 / 3.14159265358979323846);
    pi.torso_angle = clampf(pi.torso_angle, 0.f, 90.f);
    pi.shoulder_y = shy;
    pi.shoulder_y_norm = img_h > 0 ? clampf(shy / (float)img_h, -0.5f, 1.5f) : 0.f;
    pi.bbox_h_norm = img_h > 0 ? clampf(p.h / (float)img_h, 0.f, 1.5f) : 0.f;

    // Posture classification. A horizontal body is never a fall by itself.
    bool horizontal_by_angle = pi.torso_angle >= cfg_.torso_horizontal_min_deg;
    bool horizontal_by_aspect =
        pi.aspect >= cfg_.bbox_horizontal_aspect_min && pi.torso_angle >= cfg_.torso_transition_min_deg;

    if (horizontal_by_angle || horizontal_by_aspect)
    {
        pi.posture = Posture::HORIZONTAL;
    }
    else if (pi.torso_angle >= cfg_.torso_transition_min_deg)
    {
        pi.posture = Posture::TRANSITION;
    }
    else
    {
        bool sitting = false;
        float kx = 0.f, ky = 0.f;
        if (midpoint(p.kpts[13], p.kpts[14], cfg_.kpt_conf_min, &kx, &ky) && pi.aspect > 0.f)
        {
            const float hip_knee_gap = (ky - hy) / std::max(1.f, p.h);
            if (hip_knee_gap < cfg_.sitting_hip_knee_gap_ratio) sitting = true;
            float ax = 0.f, ay = 0.f;
            if (midpoint(p.kpts[15], p.kpts[16], cfg_.kpt_conf_min, &ax, &ay))
            {
                const float hip_ankle_gap = (ay - hy) / std::max(1.f, p.h);
                if (hip_ankle_gap < cfg_.crouch_hip_ankle_gap_ratio && hip_knee_gap < 0.35f) sitting = true;
            }
        }
        pi.posture = sitting ? Posture::SITTING_OR_CROUCHING : Posture::UPRIGHT;
    }

    float ratio = clampf((float)pi.valid_kpts / 12.f, 0.f, 1.f);
    float base = cfg_.posture_conf_scale * ratio + (1.f - cfg_.posture_conf_scale) * pi.kpt_avg;
    float margin = 0.12f;
    if (pi.posture == Posture::UPRIGHT)
    {
        float m = (cfg_.torso_upright_max_deg - pi.torso_angle + 5.f) / 10.f;
        margin = clampf(m, 0.f, 0.12f);
    }
    else if (pi.posture == Posture::HORIZONTAL)
    {
        float m = (pi.torso_angle - cfg_.torso_horizontal_min_deg + 5.f) / 10.f;
        margin = clampf(m, 0.f, 0.12f);
    }
    pi.confidence = clampf(base - margin, 0.f, 1.f);
    pi.ok = true;
    pi.reason = posture_name(pi.posture);
    (void)img_w;
    return pi;
}

void FallEngine::reset_candidates(int64_t now)
{
    state_ = FallState::MONITORING;
    state_since_ms_ = now;
    descent_start_ms_ = 0;
    horizontal_start_ms_ = 0;
    collapse_since_ms_ = 0;
    history_.clear();
}

void FallEngine::cancel_candidate(int64_t now, const std::string& reason, FallDecision& d)
{
    reset_candidates(now);
    add_reason(d, reason);
}

FallDecision FallEngine::process(const FrameInput& frame)
{
    FallDecision d;
    d.mono_ms = frame.mono_ms;
    d.data_valid = frame.data_valid;
    d.person_count = frame.data_valid ? (int)frame.persons.size() : -1;
    d.fall = false;
    d.fall_evaluated = false;
    d.fall_event_id = active_event_id_;
    d.recovered = false;
    d.track_switched = false;

    if (!frame.data_valid)
    {
        // Invalid input must never be interpreted as "no person" or "safe".
        d.posture = Posture::UNKNOWN;
        d.state = (state_ == FallState::FALL_CONFIRMED) ? FallState::FALL_CONFIRMED : FallState::UNKNOWN;
        if (state_ != FallState::FALL_CONFIRMED)
        {
            state_ = FallState::UNKNOWN;
            reset_candidates(frame.mono_ms);
        }
        add_reason(d, "INPUT_INVALID");
        if (!frame.error.empty()) add_reason(d, frame.error);
        d.selected_reason = frame.error.empty() ? "INPUT_INVALID" : frame.error;
        d.event_type = "STATE";
        return d;
    }

    // Monotonic time is mandatory; reject backwards timestamps rather than fabricate dt.
    if (have_last_valid_ && frame.mono_ms < last_valid_ms_)
    {
        d.data_valid = false;
        d.person_count = -1;
        d.posture = Posture::UNKNOWN;
        d.state = (state_ == FallState::FALL_CONFIRMED) ? FallState::FALL_CONFIRMED : FallState::UNKNOWN;
        d.fall_evaluated = false;
        add_reason(d, "NON_MONOTONIC_TIME");
        d.selected_reason = "NON_MONOTONIC_TIME";
        return d;
    }
    last_valid_ms_ = frame.mono_ms;
    have_last_valid_ = true;

    // ---- tracking ----
    int64_t now = frame.mono_ms;
    std::vector<std::string> det_track_id(frame.persons.size());
    std::vector<bool> track_matched(tracks_.size(), false);
    for (size_t di = 0; di < frame.persons.size(); di++)
    {
        const PersonObs& p = frame.persons[di];
        int best = -1;
        float best_score = 0.f;
        for (size_t ti = 0; ti < tracks_.size(); ti++)
        {
            if (track_matched[ti]) continue;
            Track& t = tracks_[ti];
            float i = iou_xywh(p.x, p.y, p.w, p.h, t.x, t.y, t.w, t.h);
            float dx = (p.x + p.w * 0.5f) - (t.x + t.w * 0.5f);
            float dy = (p.y + p.h * 0.5f) - (t.y + t.h * 0.5f);
            float dist = std::sqrt(dx * dx + dy * dy);
            float maxdiag = std::max(std::sqrt(p.w * p.w + p.h * p.h), std::sqrt(t.w * t.w + t.h * t.h));
            if (i >= cfg_.assoc_iou_min || dist <= cfg_.assoc_center_dist_ratio * maxdiag)
            {
                float score = i + 0.001f * p.conf;
                if (score > best_score)
                {
                    best_score = score;
                    best = (int)ti;
                }
            }
        }
        if (best >= 0)
        {
            Track& t = tracks_[best];
            t.x = p.x;
            t.y = p.y;
            t.w = p.w;
            t.h = p.h;
            t.conf = p.conf;
            t.last_seen_ms = now;
            t.missed = 0;
            t.hits++;
            track_matched[best] = true;
            det_track_id[di] = t.id;
        }
    }
    for (size_t ti = 0; ti < tracks_.size(); ti++)
    {
        if (!track_matched[ti]) tracks_[ti].missed++;
    }
    // New detections -> new tracks (after matching, to avoid consuming an existing track).
    for (size_t di = 0; di < frame.persons.size(); di++)
    {
        if (!det_track_id[di].empty()) continue;
        if ((int)tracks_.size() >= cfg_.max_tracks) continue;
        Track t;
        char idbuf[32];
        snprintf(idbuf, sizeof(idbuf), "t%d", next_track_id_++);
        t.id = idbuf;
        t.x = frame.persons[di].x;
        t.y = frame.persons[di].y;
        t.w = frame.persons[di].w;
        t.h = frame.persons[di].h;
        t.conf = frame.persons[di].conf;
        t.last_seen_ms = now;
        t.hits = 1;
        tracks_.push_back(t);
        det_track_id[di] = t.id;
        track_matched.push_back(true);
    }
    prune_tracks(now);

    if (frame.persons.empty())
    {
        d.posture = Posture::NO_PERSON;
        d.person_count = 0;
        d.track_id = primary_id_;
        if (state_ == FallState::FALL_CONFIRMED)
        {
            d.state = FallState::FALL_CONFIRMED;
            d.fall_evaluated = false;
            add_reason(d, "NO_PERSON_WHILE_CONFIRMED");
            if (now - primary_last_seen_ms_ >= (int64_t)cfg_.no_person_reset_ms)
            {
                state_ = FallState::MONITORING;
                state_since_ms_ = now;
                active_event_ = false;
                d.state = FallState::MONITORING;
                d.event_type = "RECOVERY_UNCONFIRMED";
                d.fall_event_id = last_event_id_;
                add_reason(d, "RESET_NO_PERSON_NO_RECOVERY");
            }
        }
        else
        {
            state_ = FallState::MONITORING;
            d.state = FallState::MONITORING;
            d.fall_evaluated = false;
            add_reason(d, "NO_PERSON");
        }
        d.selected_reason = "NO_PERSON";
        return d;
    }

    // ---- primary target selection ----
    Track* prev = find_track(primary_id_);
    Track* primary = NULL;
    bool primary_missing = false;
    if (prev && prev->last_seen_ms == now)
    {
        primary = prev;
    }
    else if (prev && (now - prev->last_seen_ms) <= (int64_t)cfg_.track_grace_ms)
    {
        primary = prev;
        primary_missing = true;
    }
    if (!primary)
    {
        // pick the best currently matched track with enough hits, else highest confidence
        Track* best = NULL;
        float best_score = -1.f;
        for (size_t ti = 0; ti < tracks_.size(); ti++)
        {
            Track& t = tracks_[ti];
            if (t.last_seen_ms != now) continue;
            float area = (t.w * t.h) / std::max(1.f, (float)frame.img_w * frame.img_h);
            float score = t.conf + 0.2f * std::sqrt(std::max(0.f, area));
            if (t.hits < cfg_.min_track_hits) score -= 0.15f;
            if (score > best_score)
            {
                best_score = score;
                best = &t;
            }
        }
        if (best)
        {
            if (!primary_id_.empty() && best->id != primary_id_)
            {
                d.track_switched = true;
                state_ = FallState::MONITORING;
                state_since_ms_ = now;
                descent_start_ms_ = 0;
                horizontal_start_ms_ = 0;
                history_.clear();
                active_event_ = false;
                add_reason(d, "TRACK_SWITCH");
            }
            primary_id_ = best->id;
            primary = best;
        }
    }
    if (!primary)
    {
        d.posture = Posture::UNKNOWN;
        d.state = FallState::UNKNOWN;
        d.fall_evaluated = false;
        add_reason(d, "NO_PRIMARY_TRACK");
        d.selected_reason = "NO_PRIMARY_TRACK";
        return d;
    }
    primary_last_seen_ms_ = primary->last_seen_ms;
    d.track_id = primary->id;

    if (primary_missing)
    {
        d.posture = Posture::UNKNOWN;
        d.state = (state_ == FallState::FALL_CONFIRMED) ? FallState::FALL_CONFIRMED : FallState::UNKNOWN;
        d.fall_evaluated = false;
        d.fall_event_id = active_event_id_;
        add_reason(d, "PRIMARY_LOST_GRACE");
        d.selected_reason = "PRIMARY_LOST_GRACE";
        return d;
    }

    // find detection index matched to primary track id
    int primary_det = -1;
    for (size_t i = 0; i < det_track_id.size(); i++)
    {
        if (!det_track_id[i].empty() && det_track_id[i] == primary->id)
        {
            primary_det = (int)i;
            break;
        }
    }
    if (primary_det < 0)
    {
        d.posture = Posture::UNKNOWN;
        d.state = FallState::UNKNOWN;
        d.fall_evaluated = false;
        add_reason(d, "PRIMARY_DETECTION_MISSING");
        d.selected_reason = "PRIMARY_DETECTION_MISSING";
        return d;
    }
    const PersonObs& p = frame.persons[primary_det];
    d.primary_conf = p.conf;
    d.primary_bbox[0] = p.x;
    d.primary_bbox[1] = p.y;
    d.primary_bbox[2] = p.w;
    d.primary_bbox[3] = p.h;
    for (int q = 0; q < kNumKpts; q++)
    {
        d.primary_keypoints[q * 3 + 0] = p.kpts[q].x;
        d.primary_keypoints[q * 3 + 1] = p.kpts[q].y;
        d.primary_keypoints[q * 3 + 2] = p.kpts[q].conf;
    }

    PostureInfo pi = evaluate_posture(p, frame.img_w, frame.img_h);
    d.torso_angle = pi.torso_angle;
    d.bbox_aspect = pi.aspect;
    d.valid_kpts = pi.valid_kpts;
    d.kpt_conf_avg = pi.kpt_avg;
    d.kpt_conf_min = pi.kpt_min;

    bool track_ready = primary->hits >= cfg_.min_track_hits;
    if (!pi.ok)
    {
        d.fall_evaluated = false;
        d.fall_event_id = active_event_id_;
        if (state_ == FallState::FALL_CONFIRMED)
        {
            d.posture = Posture::UNKNOWN;
            d.state = FallState::FALL_CONFIRMED;
            add_reason(d, pi.reason.empty() ? "KPT_INSUFFICIENT" : pi.reason);
            d.selected_reason = pi.reason.empty() ? "KPT_INSUFFICIENT" : pi.reason;
            return d;
        }
        // Short keypoint loss grace: keep the last known posture/state for a bounded window.
        if (have_last_posture_ && now - last_posture_ms_ <= (int64_t)cfg_.kpt_loss_grace_ms)
        {
            d.posture = last_posture_;
            d.posture_conf = last_posture_conf_;
            d.state = state_;
            add_reason(d, "KPT_LOSS_GRACE");
            d.selected_reason = "KPT_LOSS_GRACE";
            return d;
        }
        // Beyond grace -> UNKNOWN. This is not "safe" and must not be treated as NO_PERSON.
        d.posture = Posture::UNKNOWN;
        d.state = FallState::UNKNOWN;
        state_ = FallState::UNKNOWN;
        reset_candidates(now);
        add_reason(d, pi.reason.empty() ? "KPT_INSUFFICIENT" : pi.reason);
        d.selected_reason = pi.reason.empty() ? "KPT_INSUFFICIENT" : pi.reason;
        return d;
    }

    d.posture = pi.posture;
    d.posture_conf = pi.confidence;
    have_last_posture_ = true;
    last_posture_ = pi.posture;
    last_posture_conf_ = pi.confidence;
    last_posture_ms_ = now;
    d.fall_event_id = active_event_id_;
    d.fall_event_active = active_event_;
    d.fall_already_confirmed = (state_ == FallState::FALL_CONFIRMED);

    if (!track_ready)
    {
        // Posture is reported, but fall evaluation waits for short-term association to stabilise.
        d.fall_evaluated = false;
        d.state = FallState::MONITORING;
        add_reason(d, "TRACK_PENDING");
        d.selected_reason = "TRACK_PENDING";
        return d;
    }

    // Valid posture + stable track: state machine may proceed.
    float drop = 0.f;
    float velocity = 0.f;
    if (pi.hip_valid)
    {
        push_history(now, pi.hip_y_norm);
        velocity = compute_descent_velocity(now, pi.hip_y_norm, &drop);
    }
    d.descent_velocity = velocity;

    // ---- 2026-11-02 orientation-agnostic fast-collapse (port of PC patch) ----
    float shoulder_velocity = 0.f;
    if (have_last_norms_ && pi.shoulder_y_norm > last_shoulder_norm_)
    {
        int64_t dt = now - last_norms_ms_;
        if (dt >= 50 && dt <= 1500)
            shoulder_velocity = (pi.shoulder_y_norm - last_shoulder_norm_) * 1000.f / (float)dt;
    }
    bool standing_like = false;
    if (pi.hip_valid && pi.torso_valid)
    {
        const bool shoulder_above_hip = pi.shoulder_y_norm < pi.hip_y_norm;
        const bool upright_pose = pi.torso_angle <= cfg_.torso_upright_max_deg;
        standing_like = upright_pose && shoulder_above_hip &&
            (!have_standing_baseline_ || pi.hip_y_norm <= baseline_hip_norm_ + 0.02f);
        if (standing_like)
        {
            have_standing_baseline_ = true;
            standing_baseline_ms_ = now;
            baseline_hip_norm_ = pi.hip_y_norm;
            baseline_shoulder_norm_ = pi.shoulder_y_norm;
            baseline_bbox_h_norm_ = pi.bbox_h_norm;
            peak_hip_v_ = peak_shoulder_v_ = 0.f;
        }
        else
        {
            peak_hip_v_ = std::max(peak_hip_v_, velocity);
            peak_shoulder_v_ = std::max(peak_shoulder_v_, shoulder_velocity);
        }
        have_last_norms_ = true;
        last_hip_norm_ = pi.hip_y_norm;
        last_shoulder_norm_ = pi.shoulder_y_norm;
        last_norms_ms_ = now;
    }
    const bool collapse = collapse_evidence(pi, velocity, shoulder_velocity, true, now);

    if (state_ == FallState::UNKNOWN) state_ = FallState::MONITORING;

    if (state_ == FallState::FALL_CONFIRMED)
    {
        d.state = FallState::FALL_CONFIRMED;
        d.fall_evaluated = true;
        d.fall_event_id = active_event_id_;
        d.fall_event_active = active_event_;
        d.fall_already_confirmed = true;
        if (standing_like)
        {
            if (state_since_ms_ == 0) state_since_ms_ = now;
            if (now - state_since_ms_ >= (int64_t)cfg_.recovery_confirm_ms)
            {
                state_ = FallState::MONITORING;
                state_since_ms_ = now;
                d.state = FallState::MONITORING;
                d.event_type = "RECOVERED";
                d.recovered = true;
                d.fall = false;
                d.fall_evaluated = true;
                d.fall_event_id = active_event_id_;
                d.fall_event_active = false;
                active_event_ = false;
                recovered_flag_ = true;
                add_reason(d, "RECOVERED_UPRIGHT");
                d.selected_reason = "RECOVERED_UPRIGHT";
                return d;
            }
            add_reason(d, "RECOVERY_PENDING");
        }
        else
        {
            state_since_ms_ = now;
            add_reason(d, "FALL_ALREADY_CONFIRMED");
            d.selected_reason = "FALL_ALREADY_CONFIRMED";
        }
        return d;
    }

    if (state_ == FallState::MONITORING)
    {
        if (pi.posture == Posture::HORIZONTAL)
        {
            // Horizontal alone is NOT a fall: it may be a slow lie-down, sofa rest, etc.
            d.state = FallState::MONITORING;
            d.fall_evaluated = true;
            add_reason(d, "HORIZONTAL_WITHOUT_DESCENT");
            d.selected_reason = "HORIZONTAL_WITHOUT_DESCENT";
            return d;
        }
        if (collapse)
        {
            state_ = FallState::COLLAPSE_CANDIDATE;
            state_since_ms_ = now;
            collapse_since_ms_ = now;
            d.state = state_;
            d.fall_evaluated = true;
            add_reason(d, "COLLAPSE_FAST_DESCENT");
            d.selected_reason = "COLLAPSE_FAST_DESCENT";
            return d;
        }
        if (velocity >= cfg_.descent_velocity_min_per_s && drop >= cfg_.descent_drop_min)
        {
            state_ = FallState::DESCENT_CANDIDATE;
            state_since_ms_ = now;
            descent_start_ms_ = now;
            d.state = state_;
            d.fall_evaluated = true;
            add_reason(d, "RAPID_DESCENT");
            d.selected_reason = "RAPID_DESCENT";
            return d;
        }
        d.state = FallState::MONITORING;
        d.fall_evaluated = true;
        d.selected_reason = "POSTURE_" + std::string(posture_name(pi.posture));
        return d;
    }

    if (state_ == FallState::DESCENT_CANDIDATE)
    {
        if (collapse)
        {
            state_ = FallState::COLLAPSE_CANDIDATE;
            state_since_ms_ = now;
            collapse_since_ms_ = now;
            d.state = state_;
            d.fall_evaluated = true;
            add_reason(d, "COLLAPSE_AFTER_DESCENT");
            d.selected_reason = "COLLAPSE_AFTER_DESCENT";
            return d;
        }
        if (pi.posture == Posture::HORIZONTAL)
        {
            state_ = FallState::HORIZONTAL_CANDIDATE;
            state_since_ms_ = now;
            horizontal_start_ms_ = now;
            d.state = state_;
            d.fall_evaluated = true;
            add_reason(d, "HORIZONTAL_AFTER_DESCENT");
            d.selected_reason = "HORIZONTAL_AFTER_DESCENT";
            return d;
        }
        if (now - descent_start_ms_ > (int64_t)cfg_.descent_candidate_max_ms)
        {
            cancel_candidate(now, "DESCENT_TIMEOUT", d);
            d.state = FallState::MONITORING;
            d.fall_evaluated = true;
            d.selected_reason = "DESCENT_TIMEOUT";
            return d;
        }
        if (pi.posture == Posture::UPRIGHT && now - state_since_ms_ >= (int64_t)cfg_.cancel_upright_ms)
        {
            cancel_candidate(now, "DESCENT_CANCELLED_UPRIGHT", d);
            d.state = FallState::MONITORING;
            d.fall_evaluated = true;
            d.selected_reason = "DESCENT_CANCELLED_UPRIGHT";
            return d;
        }
        d.state = state_;
        d.fall_evaluated = true;
        add_reason(d, "DESCENT_CANDIDATE");
        d.selected_reason = "DESCENT_CANDIDATE";
        return d;
    }

    if (state_ == FallState::COLLAPSE_CANDIDATE)
    {
        const bool hold = collapse_evidence(pi, velocity, shoulder_velocity, false, now);
        if (standing_like && now - state_since_ms_ >= (int64_t)cfg_.cancel_upright_ms)
        {
            reset_candidates(now);
            d.state = FallState::MONITORING;
            d.fall_evaluated = true;
            add_reason(d, "COLLAPSE_CANCELLED_UPRIGHT");
            d.selected_reason = "COLLAPSE_CANCELLED_UPRIGHT";
            return d;
        }
        if (hold)
        {
            if (now - collapse_since_ms_ >= (int64_t)cfg_.collapse_confirm_ms)
            {
                state_ = FallState::FALL_CONFIRMED;
                state_since_ms_ = now;
                active_event_id_ = next_event_id(primary->id);
                active_event_ = true;
                last_event_id_ = active_event_id_;
                recovered_flag_ = false;
                d.state = state_;
                d.event_type = "FALL_CONFIRMED";
                d.fall = true; // only place where fall=true is emitted
                d.fall_evaluated = true;
                d.fall_event_id = active_event_id_;
                d.fall_event_active = true;
                d.fall_already_confirmed = false;
                add_reason(d, "FALL_CONFIRMED_COLLAPSE");
                d.selected_reason = "FALL_CONFIRMED_COLLAPSE";
                return d;
            }
            d.state = state_;
            d.fall_evaluated = true;
            add_reason(d, "COLLAPSE_CANDIDATE");
            d.selected_reason = "COLLAPSE_CANDIDATE";
            return d;
        }
        if (now - collapse_since_ms_ > (int64_t)cfg_.descent_candidate_max_ms)
        {
            reset_candidates(now);
            d.state = FallState::MONITORING;
            d.fall_evaluated = true;
            add_reason(d, "COLLAPSE_TIMEOUT");
            d.selected_reason = "COLLAPSE_TIMEOUT";
            return d;
        }
        d.state = state_;
        d.fall_evaluated = true;
        add_reason(d, "COLLAPSE_HOLD");
        d.selected_reason = "COLLAPSE_HOLD";
        return d;
    }

    if (state_ == FallState::HORIZONTAL_CANDIDATE || state_ == FallState::PERSISTENT_HORIZONTAL)
    {
        if (pi.posture != Posture::HORIZONTAL)
        {
            if (pi.posture == Posture::UPRIGHT && now - state_since_ms_ >= (int64_t)cfg_.cancel_upright_ms)
            {
                cancel_candidate(now, "HORIZONTAL_CANCELLED_UPRIGHT", d);
                d.state = FallState::MONITORING;
                d.fall_evaluated = true;
                d.selected_reason = "HORIZONTAL_CANCELLED_UPRIGHT";
                return d;
            }
            d.state = state_;
            d.fall_evaluated = true;
            d.horizontal_duration_ms = horizontal_start_ms_ ? now - horizontal_start_ms_ : 0;
            add_reason(d, "HORIZONTAL_INTERRUPTED");
            d.selected_reason = "HORIZONTAL_INTERRUPTED";
            return d;
        }
        d.horizontal_duration_ms = horizontal_start_ms_ ? now - horizontal_start_ms_ : 0;
        if (state_ == FallState::HORIZONTAL_CANDIDATE && now - horizontal_start_ms_ >= (int64_t)cfg_.horizontal_confirm_ms)
        {
            state_ = FallState::PERSISTENT_HORIZONTAL;
            state_since_ms_ = now;
        }
        if (state_ == FallState::PERSISTENT_HORIZONTAL && now - horizontal_start_ms_ >= (int64_t)cfg_.fall_confirm_ms)
        {
            state_ = FallState::FALL_CONFIRMED;
            state_since_ms_ = now;
            active_event_id_ = next_event_id(primary->id);
            active_event_ = true;
            last_event_id_ = active_event_id_;
            recovered_flag_ = false;
            d.state = state_;
            d.event_type = "FALL_CONFIRMED";
            d.fall = true; // the only place where fall=true is emitted
            d.fall_evaluated = true;
            d.fall_event_id = active_event_id_;
            d.fall_event_active = true;
            d.fall_already_confirmed = false;
            d.horizontal_duration_ms = now - horizontal_start_ms_;
            add_reason(d, "FALL_CONFIRMED_HORIZONTAL_PERSISTENT");
            d.selected_reason = "FALL_CONFIRMED_HORIZONTAL_PERSISTENT";
            return d;
        }
        d.state = state_;
        d.fall_evaluated = true;
        add_reason(d, state_ == FallState::PERSISTENT_HORIZONTAL ? "PERSISTENT_HORIZONTAL" : "HORIZONTAL_CANDIDATE");
        d.selected_reason = state_ == FallState::PERSISTENT_HORIZONTAL ? "PERSISTENT_HORIZONTAL" : "HORIZONTAL_CANDIDATE";
        return d;
    }

    // Defensive: unknown internal state
    state_ = FallState::UNKNOWN;
    d.state = FallState::UNKNOWN;
    d.fall_evaluated = false;
    add_reason(d, "INTERNAL_UNKNOWN_STATE");
    d.selected_reason = "INTERNAL_UNKNOWN_STATE";
    return d;
}

bool FallEngine::collapse_evidence(const PostureInfo& pi, float velocity,
                                   float shoulder_velocity, bool require_terminal,
                                   int64_t now) const
{
    if (!cfg_.collapse_enabled || !have_standing_baseline_) return false;
    if (!pi.hip_valid || !pi.torso_valid) return false;
    const int64_t age = now - standing_baseline_ms_;
    if (age < 0 || (float)age > cfg_.collapse_window_ms) return false;
    const float hip_drop = pi.hip_y_norm - baseline_hip_norm_;
    const float sh_drop = pi.shoulder_y_norm - baseline_shoulder_norm_;
    const float body_drop = std::max(hip_drop, sh_drop);
    const float peak = std::max(peak_hip_v_, peak_shoulder_v_);
    if (body_drop < cfg_.collapse_min_body_drop) return false;
    if (peak < cfg_.collapse_peak_drop_per_s) return false;
    if (pi.hip_y_norm < 0.58f) return false; // low context
    if (require_terminal &&
        std::max(velocity, shoulder_velocity) < cfg_.collapse_terminal_drop_per_s)
        return false; // controlled descent decelerates before the bottom
    const bool floor_hip = pi.hip_y_norm >= cfg_.collapse_floor_hip_norm;
    const bool floor_shoulder = pi.shoulder_y_norm >= cfg_.collapse_floor_shoulder_norm &&
                                pi.hip_y_norm >= 0.62f;
    const bool inverted = pi.shoulder_y_norm >= pi.hip_y_norm - cfg_.collapse_inversion_margin &&
                          pi.hip_y_norm >= 0.62f;
    bool height_collapse = false;
    if (baseline_bbox_h_norm_ > 1e-6f && pi.hip_y_norm >= 0.70f)
        height_collapse = (pi.bbox_h_norm / baseline_bbox_h_norm_ <= cfg_.collapse_height_ratio);
    return floor_hip || floor_shoulder || inverted || height_collapse;
}

} // namespace p1b









