// P1-B portable fall core: tracking, posture semantics, temporal fall state machine.
// This file is intentionally free of ncnn/HTTP/JPEG dependencies so the same code
// can be exercised by deterministic fixture/time tests and by the board program.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace p1b {

constexpr int kNumKpts = 17;

enum class Posture {
    NO_PERSON = 0,
    UPRIGHT,
    SITTING_OR_CROUCHING,
    HORIZONTAL,
    TRANSITION,
    UNKNOWN,
};

enum class FallState {
    MONITORING = 0,
    DESCENT_CANDIDATE,
    HORIZONTAL_CANDIDATE,
    PERSISTENT_HORIZONTAL,
    FALL_CONFIRMED,
    UNKNOWN,
};

const char* posture_name(Posture p);
const char* fall_state_name(FallState s);

struct Kpt {
    float x = 0.f;
    float y = 0.f;
    float conf = 0.f;
};

struct PersonObs {
    float x = 0.f, y = 0.f, w = 0.f, h = 0.f;
    float conf = 0.f;
    Kpt kpts[kNumKpts];
};

struct FrameInput {
    int64_t mono_ms = 0; // CLOCK_MONOTONIC milliseconds (never frame index)
    bool data_valid = false;
    std::string error;
    int img_w = 0;
    int img_h = 0;
    std::vector<PersonObs> persons;
};

// All thresholds live here. Rationale and tuning evidence are in FALL-STATE-MACHINE.md.
struct FallConfig {
    // keypoints / detection
    float kpt_conf_min = 0.30f;
    int min_valid_kpts = 8;
    float min_person_conf = 0.25f;

    // posture classification
    float torso_upright_max_deg = 30.f;
    float torso_transition_min_deg = 40.f;
    float torso_horizontal_min_deg = 55.f;
    float bbox_horizontal_aspect_min = 1.35f;
    float sitting_hip_knee_gap_ratio = 0.18f;
    float crouch_hip_ankle_gap_ratio = 0.45f;

    // descent candidate (normalized by image height)
    float descent_window_ms = 600.f;
    float descent_velocity_min_per_s = 0.45f;
    float descent_drop_min = 0.15f;
    float descent_candidate_max_ms = 5000.f;

    // horizontal persistence / fall confirmation
    float horizontal_confirm_ms = 800.f;
    float fall_confirm_ms = 2200.f;
    float cancel_upright_ms = 500.f;

    // recovery / loss handling
    float recovery_confirm_ms = 900.f;
    float kpt_loss_grace_ms = 600.f;
    float no_person_reset_ms = 5000.f;

    // tracking
    float track_grace_ms = 800.f;
    float track_remove_ms = 5000.f;
    float assoc_iou_min = 0.20f;
    float assoc_center_dist_ratio = 0.25f;
    int min_track_hits = 2;
    int max_tracks = 8;

    // reporting
    float posture_conf_scale = 0.5f; // blend of valid keypoints and keypoint confidence
};

struct FallDecision {
    int64_t mono_ms = 0;
    bool data_valid = false;
    int person_count = -1; // -1 when invalid; never a failure fallback for "0 persons"
    std::string track_id;
    Posture posture = Posture::UNKNOWN;
    float posture_conf = 0.f;
    FallState state = FallState::UNKNOWN;
    bool fall = false;          // true only on the unique FALL_CONFIRMED transition event
    bool fall_evaluated = false; // true only when valid input and the state machine actually evaluated
    std::string fall_event_id;
    std::string event_type = "STATE"; // STATE / FALL_CONFIRMED / RECOVERED / RECOVERY_UNCONFIRMED
    std::vector<std::string> reason_codes;

    float descent_velocity = 0.f; // image-heights / second (positive = downward)
    float torso_angle = 0.f;      // degrees from vertical
    float bbox_aspect = 0.f;      // width / height
    int64_t horizontal_duration_ms = 0;

    int valid_kpts = 0;
    float kpt_conf_avg = 0.f;
    float kpt_conf_min = 0.f;

    bool recovered = false;
    bool track_switched = false;
    bool fall_already_confirmed = false;
    bool fall_event_active = false;
    std::string selected_reason;
    float primary_conf = 0.f;
    float primary_bbox[4] = {0.f, 0.f, 0.f, 0.f};
    float primary_keypoints[51] = {0.f};
};

class FallEngine {
public:
    explicit FallEngine(FallConfig cfg = FallConfig());

    FallDecision process(const FrameInput& frame);

    void reset_state();

    const FallConfig& config() const { return cfg_; }

private:
    struct Track {
        std::string id;
        float x = 0.f, y = 0.f, w = 0.f, h = 0.f;
        float conf = 0.f;
        int64_t last_seen_ms = 0;
        int missed = 0;
        int hits = 0;
    };

    struct PostureInfo {
        bool ok = false;
        Posture posture = Posture::UNKNOWN;
        float confidence = 0.f;
        float torso_angle = 0.f;
        float aspect = 0.f;
        int valid_kpts = 0;
        float kpt_avg = 0.f;
        float kpt_min = 0.f;
        float hip_y = 0.f;
        float hip_y_norm = 0.f;
        bool hip_valid = false;
        bool torso_valid = false;
        std::string reason;
    };

    struct HistorySample {
        int64_t t_ms = 0;
        float hip_y_norm = 0.f;
    };

    FallConfig cfg_;
    std::vector<Track> tracks_;
    std::string primary_id_;
    std::vector<HistorySample> history_;
    int next_track_id_ = 1;
    uint64_t next_event_seq_ = 1;

    FallState state_ = FallState::MONITORING;
    int64_t state_since_ms_ = 0;
    int64_t descent_start_ms_ = 0;
    int64_t horizontal_start_ms_ = 0;
    int64_t last_valid_ms_ = 0;
    bool have_last_valid_ = false;
    std::string active_event_id_;
    std::string last_event_id_;
    bool active_event_ = false;
    bool recovered_flag_ = false;
    bool last_primary_matched_ = false;
    int64_t primary_last_seen_ms_ = 0;
    bool have_last_posture_ = false;
    Posture last_posture_ = Posture::UNKNOWN;
    float last_posture_conf_ = 0.f;
    int64_t last_posture_ms_ = 0;

    void reset_candidates(int64_t now);
    void cancel_candidate(int64_t now, const std::string& reason, FallDecision& d);
    PostureInfo evaluate_posture(const PersonObs& p, int img_w, int img_h) const;
    Track* find_track(const std::string& id);
    const Track* find_track(const std::string& id) const;
    void prune_tracks(int64_t now);
    std::string next_event_id(const std::string& track_id);
    void add_reason(FallDecision& d, const std::string& code) const;
    float compute_descent_velocity(int64_t now, float hip_y_norm, float* drop_out) const;
    void push_history(int64_t now, float hip_y_norm);
};

} // namespace p1b





