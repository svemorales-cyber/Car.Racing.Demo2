

extern "C" {
__attribute__((import_module("env"), import_name("sin"))) double js_sin(double);
__attribute__((import_module("env"), import_name("cos"))) double js_cos(double);
__attribute__((import_module("env"), import_name("exp"))) double js_exp(double);
}

#define WASM_EXPORT(name) extern "C" __attribute__((export_name(#name)))

enum Action { GAS, BRAKE, LEFT, RIGHT, DRIFT, BOOST, NUM_ACTIONS };
enum Command { NO_CMD, CMD_CAMERA, CMD_MUTE, CMD_RESPAWN, CMD_PAUSE, CMD_START };

struct KeyBind {
    const char *code;
    int id;
};


static const KeyBind kActionKeys[] = {
    {"KeyW", GAS},       {"ArrowUp", GAS},
    {"KeyS", BRAKE},     {"ArrowDown", BRAKE},
    {"KeyA", LEFT},      {"ArrowLeft", LEFT},
    {"KeyD", RIGHT},     {"ArrowRight", RIGHT},
    {"Space", DRIFT},
    {"ShiftLeft", BOOST}, {"ShiftRight", BOOST}, {"KeyN", BOOST},
};

static const KeyBind kCommandKeys[] = {
    {"KeyC", CMD_CAMERA},
    {"KeyM", CMD_MUTE},
    {"KeyR", CMD_RESPAWN},
    {"Escape", CMD_PAUSE}, {"KeyP", CMD_PAUSE},
    {"Enter", CMD_START},  {"NumpadEnter", CMD_START},
};

static bool g_held[NUM_ACTIONS];
static char g_key[32];   

static bool key_is(const char *code, int len)
{
    int i = 0;
    for (; i < len; i++) {
        if (code[i] != g_key[i])
            return false;
    }
    return code[i] == '\0';
}

WASM_EXPORT(key_buffer) char *key_buffer() { return g_key; }


WASM_EXPORT(on_key) int on_key(int len, int down, int repeat)
{
    for (const KeyBind &k : kActionKeys) {
        if (key_is(k.code, len)) {
            g_held[k.id] = down;
            return 0;
        }
    }
    for (const KeyBind &k : kCommandKeys) {
        if (key_is(k.code, len))
            return (down && !repeat) ? k.id : NO_CMD;
    }
    return -1;
}


WASM_EXPORT(set_action) void set_action(int a, int down)
{
    if (a >= 0 && a < NUM_ACTIONS)
        g_held[a] = down;
}

WASM_EXPORT(action_down) int action_down(int a)
{
    return a >= 0 && a < NUM_ACTIONS && g_held[a];
}


WASM_EXPORT(release_all) void release_all()
{
    for (bool &h : g_held)
        h = false;
}



struct Car {
 
    double dt, locked, finished, grass, wet, damage;
  
    double x, z, angle, vx, vz, steer, nitro, was_boosting;
   
    double fwd_speed, side_speed, yaw, boosting, drifting;
    double gas, brake, nitro_started;
    double fx, fz, rx, rz;
    double slip_front, slip_rear;   // how much of each axle's grip is in use, 1 = at the limit
    double wheel_angle;              // front wheel angle (rad) incl. counter-steer, for drawing
    double hb_time;                  // how long the handbrake has been held
    double damage_pull;              // race option: bent steering from crashes, + pulls right
    double steer_axis, gas_axis, brake_axis;   // game pad: stick -1..1, triggers 0..1 (0 = keys only)
    double power_mul, grip_f_mul, grip_r_mul, brake_mul, aero_mul;   // broken parts, 1 = healthy (0 = not set)
    double tyre_pull;                // a flat tyre drags the car to its side, + right
    double pit_limit;                // pit lane speed limiter (m/s), 0 = off
    double top_mul;                  // limp mode: share of the top speed left (0 = not set)
    double drs;                      // rear wing flap open: less drag, a bit less downforce
};

static Car car;

WASM_EXPORT(car_state) Car *car_state() { return &car; }

namespace {


const double kReverseAccel = 14;
const double kReverseTop   = 12;
const double kGrassGrip    = 4.5;


const double kWetGrip      = 0.68;
const double kWetBrake     = 0.75;
const double kWetAccel     = 0.92;

// grip is in "game g": the cars corner much harder than real ones, the tyre behaviour is what's real
const double kMuScale      = 3.1;
const double kCgHeight     = 0.0062;   // load moved front<->rear per m/s^2 of acceleration
const double kHandbrake    = 0.12;     // rear brake force from the handbrake, share of rear grip
const double kTractionCtl  = 0.62;     // drive force never uses more than this share of grip
const double kMaxSlip      = 0.5;      // body slip (rad) where the drift helper starts to catch the car
const int    kSubsteps     = 6;

inline double absd(double v) { return v < 0 ? -v : v; }
inline double mind(double a, double b) { return a < b ? a : b; }
inline double maxd(double a, double b) { return a > b ? a : b; }
inline double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline double sqr(double v) { return v * v; }
inline double sgn(double v) { return (v > 0) - (v < 0); }
inline int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// no libm in here
double sqrtd(double v)
{
    if (v <= 0)
        return 0;
    double r = v > 1 ? v : 1;
    for (int i = 0; i < 20; i++)
        r = 0.5 * (r + v / r);
    return r;
}

double atand(double x)
{
    if (x < 0)
        return -atand(-x);
    if (x > 1)
        return 1.5707963267948966 - atand(1 / x);
    double x2 = x * x;
    return x * (0.9998660 + x2 * (-0.3302995 + x2 * (0.1801410 + x2 * (-0.0851330 + x2 * 0.0208351))));
}

inline double atan2d(double y, double x)
{
    if (x > 0) return atand(y / x);
    if (x < 0) return atand(y / x) + (y >= 0 ? 3.141592653589793 : -3.141592653589793);
    return y > 0 ? 1.5707963267948966 : (y < 0 ? -1.5707963267948966 : 0);
}



struct CarSpec {
    double top, accel;
    double nitro_top, nitro_accel, nitro_burn;
    double brake;
    double steer, drift_steer;
    double grip, drift_grip;
    double wheelbase, front;   // front = share of weight on the front axle
    double rear_drive;         // share of drive on the rear wheels (1 = RWD)
};

// VELOCE GT4, KAZE R34, RYU S15, APEX HYPER, STALLION GT, RENNER TURBO S, TORO V10
// (same order as MODELS in game.js)
const CarSpec kModels[] = {
    {  41,  26,    56,   38,   0.30, 38,   2.50, 1.75,  12.0, 1.4,   2.48, 0.44, 1.00 },
    {  44,  28,    59,   41,   0.30, 38,   2.40, 1.70,  12.5, 1.3,   2.67, 0.55, 0.65 },
    {  42,  27,    56,   40,   0.26, 36,   2.80, 2.05,  10.5, 1.0,   2.55, 0.54, 1.00 },
    {  48,  32,    65,   45,   0.32, 42,   2.35, 1.70,  13.0, 1.5,   2.68, 0.42, 1.00 },
    {  45,  30,    60,   42,   0.30, 37,   2.30, 1.85,  11.5, 1.2,   2.82, 0.53, 1.00 },
    {  46,  31,    61,   43,   0.30, 43,   2.55, 1.75,  13.2, 1.4,   2.45, 0.39, 0.70 },
    {  50,  33,    66,   46,   0.32, 43,   2.40, 1.70,  13.5, 1.5,   2.62, 0.43, 0.60 },
};
const int kModelCount = sizeof(kModels) / sizeof(kModels[0]);
const int kMaxLevel = 5;

struct Spoiler { double downforce, drag; };
const Spoiler kSpoilers[] = { {0, 0}, {0.06, 0.003}, {0.14, 0.012}, {0.22, 0.022} };

// upgrade levels 0..5 for each part, plus two setup sliders (-100..100)
struct Parts {
    int engine, turbo, nitro, tires, brakes, susp, weight, spoiler;
    int gearing;   // - = short gears (acceleration), + = long gears (top speed)
    int balance;   // - = grip, + = loose / drifty
};

struct Tune {
    double top, accel, nitro_top, nitro_accel, nitro_burn;
    double brake, steer, drift_steer, grip, drift_grip, grass_grip;
    double wet_grip, wet_brake, downforce;
    double wheelbase, front, rear_drive, rear_bias;
};
Tune tune;

void build_tune(int model, Parts p)
{
    const CarSpec &m = kModels[clampi(model, 0, kModelCount - 1)];
    const Spoiler &sp = kSpoilers[clampi(p.spoiler, 0, 3)];
    const double en = clampi(p.engine, 0, kMaxLevel), tu = clampi(p.turbo, 0, kMaxLevel);
    const double ni = clampi(p.nitro, 0, kMaxLevel), ti = clampi(p.tires, 0, kMaxLevel);
    const double br = clampi(p.brakes, 0, kMaxLevel), su = clampi(p.susp, 0, kMaxLevel);
    const double we = clampi(p.weight, 0, kMaxLevel);
    const double gear = clampi(p.gearing, -100, 100) / 100.0;
    const double bal  = clampi(p.balance, -100, 100) / 100.0;

    Tune &t = tune;
    // engine: power everywhere. turbo: mostly pull. weight: a bit of everything
    // a maxed car should feel stronger, not like a different game: top speed only goes up ~15%
    t.top         = m.top * (1 + 0.025 * en) * (1 + 0.04 * gear) * (1 - sp.drag);
    t.accel       = m.accel * (1 + 0.045 * en) * (1 + 0.05 * tu) * (1 + 0.03 * we) * (1 - 0.1 * gear);
    t.nitro_top   = mind(t.top * 1.25, m.nitro_top * (1 + 0.02 * en) * (1 + 0.03 * ni) * (1 + 0.03 * gear) * (1 - sp.drag));
    t.nitro_accel = m.nitro_accel * (1 + 0.04 * tu) * (1 + 0.04 * ni);
    t.nitro_burn  = m.nitro_burn * (1 - 0.1 * ni);
    t.brake       = m.brake * (1 + 0.15 * br) * (1 + 0.05 * we);
    t.wet_brake   = mind(0.98, kWetBrake + 0.04 * br);
    t.steer       = m.steer * (1 + 0.05 * su) * (1 + 0.03 * we);
    t.drift_steer = m.drift_steer * (1 + 0.15 * bal);
    t.grip        = m.grip * (1 + 0.09 * ti);
    t.drift_grip  = m.drift_grip * (1 + 0.04 * ti) * (1 + 0.5 * bal);
    t.grass_grip  = kGrassGrip * (1 + 0.12 * ti);
    t.wet_grip    = mind(0.95, kWetGrip + 0.05 * ti);
    t.downforce   = sp.downforce + 0.02 * su;
    t.wheelbase   = m.wheelbase;
    t.front       = m.front;
    t.rear_drive  = m.rear_drive;
    // set up to understeer a little, like a road car. balance slider: + = less rear grip = more oversteer
    t.rear_bias   = 1.12 - 0.16 * bal;
}

// lateral force of one axle for a slip angle, as a share of what the axle can give.
// rises almost linearly, peaks at `peak` rad, then drops off to a sliding level set by `shape`
double tyre_curve(double slip, double peak, double shape)
{
    double b = 2.36 / peak;
    double x = shape * atand(b * absd(slip));
    double y = x < 1.5707963267948966 ? js_sin(x) : js_sin(3.141592653589793 - x);
    return slip < 0 ? -y : y;
}

}

WASM_EXPORT(model_count) int model_count() { return kModelCount; }

WASM_EXPORT(set_setup) void set_setup(int model, int engine, int turbo, int nitro, int tires, int brakes,
                                      int susp, int weight, int spoiler, int gearing, int balance)
{
    build_tune(model, Parts{engine, turbo, nitro, tires, brakes, susp, weight, spoiler, gearing, balance});
}

// numbers for the garage screen
WASM_EXPORT(setup_value) double setup_value(int which)
{
    switch (which) {
    case 0: return tune.top;
    case 1: return tune.accel;
    case 2: return tune.grip * (1 + tune.downforce * 0.5);
    case 3: return tune.brake;
    case 4: return tune.steer;
    case 5: return tune.nitro_top;
    case 6: return tune.nitro_burn;
    case 7: return tune.drift_grip * tune.drift_steer;
    }
    return 0;
}

// bicycle model in the car's frame: u forward, v right, r yaw rate (+ = turning right).
// side force per axle from its slip angle, limited by what braking/driving already uses (friction circle)
WASM_EXPORT(drive) void drive()
{
    Car &c = car;
    if (tune.top == 0)
        build_tune(0, Parts{});
    const double dt = c.dt;
    const bool locked = c.locked != 0;
    const bool grass  = c.grass != 0;
    const bool wet    = c.wet != 0;
    const double dmg  = c.damage;
    auto health = [](double m) { return m > 0 ? m : 1.0; };
    const double pw_mul = health(c.power_mul), gf_mul = health(c.grip_f_mul), gr_mul = health(c.grip_r_mul);
    const double br_mul = health(c.brake_mul), ae_mul = health(c.aero_mul) * (c.drs > 0 ? 0.6 : 1);
    const double drag = c.drs > 0 ? 0.55 : 1;

    bool gas = false, brake = true, handbrake = false, nitro = false;
    int steer_in = 0;
    double steer_amt = 0, gas_amt = 1, brake_amt = 1;
    if (!c.finished) {
        gas       = g_held[GAS];
        brake     = g_held[BRAKE];
        handbrake = g_held[DRIFT];
        nitro     = g_held[BOOST];
        steer_in  = int(g_held[RIGHT]) - int(g_held[LEFT]);
        steer_amt = steer_in;
        // a pad is analogue: part throttle, part brake, any steering angle
        if (absd(c.steer_axis) > 0.08) {
            steer_amt = c.steer_axis;
            steer_in = int(sgn(c.steer_axis));
        }
        if (c.gas_axis > 0.04) {
            gas = true;
            gas_amt = c.gas_axis;
        }
        if (c.brake_axis > 0.04) {
            brake = true;
            brake_amt = c.brake_axis;
        }
    }

    double want = steer_amt;
    want += c.damage_pull * 0.1 + c.tyre_pull * 0.12;
    c.steer += (want - c.steer) * mind(1.0, dt * (steer_in ? 7 : 10));

    double sa = js_sin(c.angle), ca = js_cos(c.angle);
    double u = c.vx * sa + c.vz * ca;
    double v = c.vx * -ca + c.vz * sa;
    double r = c.yaw;

    bool boosting = !locked && nitro && c.nitro > 0 && u > -1;
    c.nitro_started = boosting && !c.was_boosting;
    c.was_boosting = boosting;
    if (boosting)
        c.nitro = maxd(0, c.nitro - dt * tune.nitro_burn);

    double top = boosting ? tune.nitro_top : tune.top;
    if (grass) top *= 0.5;
    top *= (1 - 0.08 * dmg) * (0.78 + 0.22 * pw_mul);
    top *= health(c.top_mul) * (c.drs > 0 ? 1.06 : 1);
    if (c.pit_limit > 0)
        top = mind(top, c.pit_limit);

    // surface
    double mu = (grass ? tune.grass_grip : tune.grip) * kMuScale;
    double peak = 0.11, shape = 1.32;
    if (wet) {
        mu *= tune.wet_grip;
        peak = 0.085;   // lets go earlier
        shape = 1.5;    // and slides on less grip once it has
    }
    if (grass)
        shape = 1.45;

    const double L = tune.wheelbase, a = L * (1 - tune.front), b = L * tune.front;
    const double inertia = a * b;
    double slip_f = 0, slip_r = 0, ax = 0, wheel = 0;
    c.hb_time = handbrake ? c.hb_time + dt : 0;
    double beta_prev = absd(u) > 2 ? atan2d(v, absd(u)) : 0;
    bool drifting = false;

    if (locked) {
        u = v = r = 0;
    } else {
        const double h = dt / kSubsteps;
        double ay = 0;
        for (int step = 0; step < kSubsteps; step++) {
            double speed = absd(u);
            double aero = 1 + tune.downforce * sqr(mind(1.2, speed / tune.top)) * 1.6 * ae_mul;
            double load_shift = clampd(ax * kCgHeight, -0.18, 0.18);
            // cornering hard moves weight onto the outside tyres, and a loaded tyre grips less per kg
            double lat_load = 1 - 0.07 * mind(1.0, sqr(ay / maxd(1.0, mu * aero)));
            double grip_f = mu * aero * lat_load * maxd(0.1, tune.front - load_shift) * gf_mul;
            double grip_r = mu * aero * lat_load * maxd(0.1, 1 - tune.front + load_shift) * tune.rear_bias * gr_mul;
            double hb = 0;
            if (handbrake) {
                // full bite for the first moment to break the rear loose; after that, on the gas,
                // it only keeps the tail light so the car carries its speed through the slide
                double bite = c.hb_time < 0.35 ? 1 : (gas ? 0.15 : 0.6);
                hb = grip_r * kHandbrake * bite;
                grip_r *= tune.drift_grip / 1.4 * 0.62;
            }

            // longitudinal: engine, brakes, drag
            double drive = 0, brake_f = 0, brake_r = 0;
            if (gas || boosting) {
                double acc = boosting ? tune.nitro_accel : tune.accel;
                if (wet) acc *= kWetAccel;
                acc *= (1 - 0.06 * dmg) * pw_mul;
                // full thrust up to about a third of top speed, then the power runs out (force ~ power / speed)
                double rel = maxd(u, 1.0) / top;
                drive = acc * mind(1.0, 0.32 / rel) * (1 - 0.5 * sqr(rel)) * (boosting ? 1 : gas_amt);
                if (u > top)
                    drive = 0;
            }
            bool reversing = false;
            if (brake) {
                if (u > 0.5) {
                    double bf = tune.brake * (wet ? tune.wet_brake : 1) * brake_amt * br_mul;
                    brake_f = bf * 0.62;
                    brake_r = bf * 0.38;
                } else {
                    reversing = true;
                }
            }
            if (u > 0.5)
                brake_r += hb;

            // what each axle can put down (ABS / traction control keep a bit for cornering)
            // already sliding and still on the gas: the rear wheels spin up and keep the slide going
            bool power_slide = drive > 0 && absd(v - b * r) > 0.18 * maxd(speed, 1.0);
            double drive_r = mind(drive * tune.rear_drive, grip_r * (power_slide ? 0.82 : kTractionCtl));
            double drive_f = mind(drive * (1 - tune.rear_drive), grip_f * kTractionCtl);
            brake_f = mind(brake_f, grip_f * 0.8);
            brake_r = mind(brake_r, grip_r * (handbrake ? 0.95 : 0.8));
            double fx_f = drive_f - brake_f, fx_r = drive_r - brake_r;

            // steering: on the keyboard full lock would just plough the front, so the
            // lock is limited to a bit past the angle that gives the most grip at this speed
            double ideal = L * tune.grip * kMuScale * 0.85 / maxd(25.0, sqr(speed)) + peak;
            double lock = mind(0.6, ideal * (0.85 + 0.06 * tune.steer));
            double beta = speed > 2 ? atan2d(v, speed) : 0;
            double delta = c.steer * lock;
            // let go of the keys in a slide and the wheels catch it (counter-steer)
            if (steer_in == 0 && absd(beta) > 0.08)
                delta = clampd(beta * 0.75, -0.6, 0.6);
            else if (sgn(c.steer) != 0 && sgn(c.steer) == sgn(beta))
                delta = c.steer * mind(0.6, lock + absd(beta) * 0.45 * tune.drift_steer);   // counter-steering gets more lock

            double fy_f = 0, fy_r = 0;
            double blend = u > 0 ? clampd((u - 3) / 5, 0, 1) : 0;   // slow or reversing: plain geometry
            if (blend > 0) {
                double us = maxd(speed, 1.0);
                double alpha_f = atan2d(v + a * r, us) - delta * (u < 0 ? -1 : 1);
                double alpha_r = atan2d(v - b * r, us);
                double cap_f = sqrtd(maxd(0, sqr(grip_f) - sqr(fx_f)));
                double cap_r = sqrtd(maxd(0, sqr(grip_r) - sqr(fx_r)));
                fy_f = -cap_f * tyre_curve(alpha_f, peak, shape);
                // rear tyres are a little more forgiving past the limit, or every slide would be a spin
                fy_r = -cap_r * tyre_curve(alpha_r, peak * 1.25, maxd(1.1, shape - 0.17));
                slip_f = maxd(slip_f, absd(alpha_f) / peak);
                slip_r = maxd(slip_r, absd(alpha_r) / (peak * 1.25));
            }

            wheel = delta;
            double cosd = js_cos(delta), sind = js_sin(delta);
            double du = fx_r + fx_f * cosd - fy_f * sind + v * r;
            double dv = fy_r + fy_f * cosd + fx_f * sind - u * r;
            double dr = (a * fy_f * cosd - b * fy_r) / inertia;

            if (reversing)
                du = u > -kReverseTop ? -kReverseAccel * brake_amt : 0;
            // rolling resistance, air drag (grows with the square of speed); grass and gravel slow you down
            // more the faster you go (a fixed drag would pin a car that has little traction there)
            du -= sgn(u) * (0.8 + absd(u) * (0.012 + (grass ? 0.3 : 0)) + sqr(u) * 0.00042 * drag);
            // off the throttle the engine holds the car back
            if (!gas && !boosting && !brake && u > 1)
                du -= 0.9;
            if (u > top)
                du -= (u - top) * (c.pit_limit > 0 ? 6 : 2);

            // drift: while the handbrake is on or the rear is sliding under power, hold a slide angle.
            // steer into the turn for more angle, counter-steer to straighten up, let go to keep it.
            double beta_rate = (beta - beta_prev) / h;
            beta_prev = beta;
            bool drift_assist = blend > 0 && speed > 9 && (handbrake || (drive > 0 && absd(beta) > 0.2));
            if (drift_assist) {
                double max_angle = 0.5 * tune.drift_steer / 1.75;
                double target;
                if (steer_in == 0)
                    target = beta * 0.9;
                else if (sgn(beta) == steer_in)
                    target = beta * 0.4;
                else
                    target = -steer_in * max_angle;
                dr += (40 * (beta - target) + 8 * beta_rate) * blend;
                // a drift is a way round the corner, not off it: the slide keeps about the grip line's
                // cornering force (more steering into the turn = tighter, counter-steer = wider)
                // (pushed square to the way the car travels, so it bends the line without braking it)
                double travel = sqrtd(u * u + v * v);
                if (absd(beta) > 0.03 && travel > 1) {
                    double side = -sgn(v);
                    double nu = -v / travel * side, nv = u / travel * side;
                    double fu = fx_r + fx_f * cosd - fy_f * sind, fv = fy_r + fy_f * cosd + fx_f * sind;
                    double k = steer_in == 0 ? 0.9 : (sgn(beta) != steer_in ? 1.0 : 0.72);
                    double extra = maxd(0, k * mu * aero * 0.97 - (fu * nu + fv * nv)) * mind(1.0, absd(beta) / 0.12);
                    du += extra * nu * blend;
                    dv += extra * nv * blend;
                }
                // on the gas the spinning rear wheels push the car along its line, so a drift doesn't die
                // (only as much as the slide costs: going straight with the handbrake gives nothing extra)
                if (drive > 0 && absd(beta) > 0.05) {
                    double travel = sqrtd(u * u + v * v);
                    double push = drive * (handbrake ? 0.8 : 0.55) * mind(1.0, absd(beta) / 0.3);
                    du += push * u / travel;
                    dv += push * v / travel;
                }
            }
            // past kMaxSlip the car is turned back towards its direction of travel
            double over = absd(beta) - kMaxSlip;
            if (blend > 0 && over > 0)
                dr += sgn(beta) * over * 150 * blend;
            // stability control: a yaw rate the tyres could never hold means a spin is starting
            if (!handbrake && !drift_assist && blend > 0) {
                double r_max = mu * aero / maxd(u, 5.0);
                double spin = absd(r) - 1.1 * r_max;
                if (spin > 0)
                    dr -= sgn(r) * spin * 120;
            }

            double u_new = u + du * h;
            if (!gas && !brake && !boosting && absd(u_new) < 0.4)
                u_new = 0;
            if (u > 0 && u_new < 0 && !reversing)
                u_new = 0;
            ax = (u_new - u) / h;
            u = u_new;
            ay = u * r;
            v += dv * h * blend;
            r += dr * h * blend;

            // geometry at low speed: the car goes where the wheels point
            double r_kin = u * js_sin(c.steer * 0.6) / L;
            r += (r_kin - r) * (1 - blend);
            v *= 1 - (1 - blend) * mind(1.0, h * 12);

            c.angle -= r * h;
            sa = js_sin(c.angle); ca = js_cos(c.angle);
            c.x += (sa * u - ca * v) * h;
            c.z += (ca * u + sa * v) * h;
        }
        drifting = absd(u) > 9 && (handbrake || absd(v) > 3.2 || absd(atan2d(v, absd(u))) > 0.14);
    }

    double fx = sa, fz = ca;
    double rx = -ca, rz = sa;
    c.vx = fx * u + rx * v;
    c.vz = fz * u + rz * v;

    c.fwd_speed = u;
    c.side_speed = v;
    c.yaw = r;
    c.boosting = boosting;
    c.drifting = drifting;
    c.gas = gas;
    c.brake = brake;
    c.fx = fx; c.fz = fz;
    c.rx = rx; c.rz = rz;
    c.slip_front = slip_f;
    c.slip_rear = slip_r;
    c.wheel_angle = locked ? 0 : (absd(u) > 3 ? wheel : c.steer * 0.6);
}


// ---------------------------------------------------------------------------------------------
// Tumbling: after a big side hit a car stops being a "driving" car and becomes a box with real
// 3D rigid body physics (gravity, ground contact at its corners, friction) until it comes to rest.
// The game fills in the start state, calls tumble_step every frame and reads the result back.

struct Body {
    double px, py, pz;          // centre of the box (m)
    double vx, vy, vz;          // velocity (m/s)
    double qw, qx, qy, qz;      // orientation
    double wx, wy, wz;          // angular velocity (rad/s, world)
    double hx, hy, hz;          // half size of the box
    double rest_time;           // how long it has been lying still
    double hit;                 // hardest ground impact in the last step (for damage / sound)
};

static Body g_bodies[8];

WASM_EXPORT(body_state) Body *body_state(int i) { return &g_bodies[clampi(i, 0, 7)]; }

namespace {

struct V3 { double x, y, z; };
inline V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 operator*(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }

// rotate v by the body's orientation (and back)
V3 rot(const Body &b, V3 v)
{
    V3 q = {b.qx, b.qy, b.qz};
    V3 t = cross(q, v) * 2;
    return v + t * b.qw + cross(q, t);
}
V3 unrot(const Body &b, V3 v)
{
    V3 q = {-b.qx, -b.qy, -b.qz};
    V3 t = cross(q, v) * 2;
    return v + t * b.qw + cross(q, t);
}

// inverse inertia of a solid box (mass 1) applied to a world vector
V3 inv_inertia(const Body &b, V3 v)
{
    double ix = (b.hy * b.hy + b.hz * b.hz) / 3, iy = (b.hx * b.hx + b.hz * b.hz) / 3, iz = (b.hx * b.hx + b.hy * b.hy) / 3;
    V3 l = unrot(b, v);
    return rot(b, {l.x / ix, l.y / iy, l.z / iz});
}

void apply(Body &b, V3 r, V3 j)
{
    b.vx += j.x; b.vy += j.y; b.vz += j.z;
    V3 dw = inv_inertia(b, cross(r, j));
    b.wx += dw.x; b.wy += dw.y; b.wz += dw.z;
}

const double kGravity   = 9.81;
const double kBounce    = 0.25;
const double kFriction  = 0.75;

}

// returns 0 while it moves, 1 when it has settled on its wheels, 2 when it settled on its side or roof
WASM_EXPORT(tumble_step) int tumble_step(int i, double dt)
{
    Body &b = g_bodies[clampi(i, 0, 7)];
    const int steps = 8;
    const double h = dt / steps;
    b.hit = 0;
    bool touching = false;
    int wheels_down = 0;
    for (int s = 0; s < steps; s++) {
        b.vy -= kGravity * h;
        b.px += b.vx * h; b.py += b.vy * h; b.pz += b.vz * h;
        // q += 0.5 * (0, w) * q * h
        double qw = b.qw, qx = b.qx, qy = b.qy, qz = b.qz;
        b.qw += 0.5 * h * (-b.wx * qx - b.wy * qy - b.wz * qz);
        b.qx += 0.5 * h * ( b.wx * qw + b.wy * qz - b.wz * qy);
        b.qy += 0.5 * h * ( b.wy * qw + b.wz * qx - b.wx * qz);
        b.qz += 0.5 * h * ( b.wz * qw + b.wx * qy - b.wy * qx);
        double ql = sqrtd(b.qw * b.qw + b.qx * b.qx + b.qy * b.qy + b.qz * b.qz);
        b.qw /= ql; b.qx /= ql; b.qy /= ql; b.qz /= ql;

        // ground contacts at the 8 corners of the box (two passes so stacked contacts settle)
        for (int pass = 0; pass < 2; pass++) {
            double deepest = 0;
            for (int c = 0; c < 8; c++) {
                bool wheel = !(c & 2);   // the four bottom corners are where the wheels are
                V3 r = rot(b, {(c & 1 ? 1 : -1) * b.hx, (c & 2 ? 1 : -1) * b.hy, (c & 4 ? 1 : -1) * b.hz});
                double y = b.py + r.y;
                if (y >= 0)
                    continue;
                touching = true;
                if (wheel && s == steps - 1 && pass == 0)
                    wheels_down++;
                deepest = mind(deepest, y);
                V3 v = V3{b.vx, b.vy, b.vz} + cross(V3{b.wx, b.wy, b.wz}, r);
                if (v.y >= 0)
                    continue;
                V3 n = {0, 1, 0};
                double k = 1 + dot(n, cross(inv_inertia(b, cross(r, n)), r));
                double jn = -(1 + kBounce) * v.y / k;
                apply(b, r, n * jn);
                b.hit = maxd(b.hit, jn);
                // friction against the sliding direction, limited by the normal impulse.
                // a wheel on the ground rolls: almost no friction along the car, full grip across it
                V3 vt = V3{b.vx, b.vy, b.vz} + cross(V3{b.wx, b.wy, b.wz}, r);
                vt.y = 0;
                if (wheel && rot(b, {0, 1, 0}).y > 0.5) {
                    V3 fw = rot(b, {0, 0, 1});
                    fw.y = 0;
                    double fl = sqrtd(dot(fw, fw));
                    if (fl > 1e-3) {
                        fw = fw * (1 / fl);
                        vt = vt + fw * (-0.97 * dot(vt, fw));
                    }
                }
                double sp = sqrtd(dot(vt, vt));
                if (sp > 1e-4) {
                    V3 t = vt * (1 / sp);
                    double kt = 1 + dot(t, cross(inv_inertia(b, cross(r, t)), r));
                    double jt = mind(sp / kt, kFriction * jn);
                    apply(b, r, t * -jt);
                }
            }
            if (deepest < 0)
                b.py -= deepest * 0.6;
        }
        double damp = 1 - 0.15 * h;
        b.wx *= damp; b.wy *= damp; b.wz *= damp;
    }

    double speed = sqrtd(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    double spin = sqrtd(b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
    double up = rot(b, {0, 1, 0}).y;
    // back on its wheels and not bouncing any more: it can drive on, at whatever speed it still has
    bool landed = wheels_down >= 3 && up > 0.9 && spin < 0.8 && absd(b.vy) < 1;
    bool still = touching && speed < 0.6 && spin < 0.6;
    b.rest_time = landed || still ? b.rest_time + dt : 0;
    if (b.rest_time < (landed ? 0.2 : 0.5))
        return 0;
    return up > 0.75 ? 1 : 2;
}
