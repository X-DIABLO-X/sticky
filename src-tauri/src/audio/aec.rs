/// Acoustic Echo Cancellation (AEC) and Noise Suppression Filter
pub struct AecProcessor {
    filter_weights: Vec<f32>,
    history: Vec<f32>,
    step_size: f32,
    leakage: f32,
    noise_floor: f32,
    hp_prev_in: f32,
    hp_prev_out: f32,
}

impl Default for AecProcessor {
    fn default() -> Self {
        Self::new(64, 0.01, 0.999)
    }
}

impl AecProcessor {
    pub fn new(filter_len: usize, step_size: f32, leakage: f32) -> Self {
        Self {
            filter_weights: vec![0.0; filter_len],
            history: vec![0.0; filter_len],
            step_size,
            leakage,
            noise_floor: 0.001,
            hp_prev_in: 0.0,
            hp_prev_out: 0.0,
        }
    }

    /// High-pass filter (cutoff ~80Hz at 16kHz) to remove DC bias and rumble
    pub fn high_pass_filter(&mut self, sample: f32) -> f32 {
        let alpha = 0.969;
        let out = alpha * (self.hp_prev_out + sample - self.hp_prev_in);
        self.hp_prev_in = sample;
        self.hp_prev_out = out;
        out
    }

    /// Process microphone input with reference speaker sample using Normalized LMS
    pub fn process_sample(&mut self, mic_sample: f32, ref_sample: f32) -> f32 {
        let filtered_mic = self.high_pass_filter(mic_sample);

        // Update speaker reference history ring
        self.history.pop();
        self.history.insert(0, ref_sample);

        // Compute predicted echo: dot product of weights and history
        let mut echo_estimate = 0.0;
        let mut power = 1e-6;
        for (w, &h) in self.filter_weights.iter().zip(self.history.iter()) {
            echo_estimate += w * h;
            power += h * h;
        }

        // Cleaned error signal
        let error = filtered_mic - echo_estimate;

        // NLMS weight adaptation with leakage
        let normalized_step = self.step_size / power;
        for (w, &h) in self.filter_weights.iter_mut().zip(self.history.iter()) {
            *w = (*w * self.leakage) + (normalized_step * error * h);
        }

        // Simple spectral / soft noise suppression
        let abs_err = error.abs();
        if abs_err < self.noise_floor {
            self.noise_floor = 0.999 * self.noise_floor + 0.001 * abs_err;
            error * 0.1
        } else {
            self.noise_floor = 0.9999 * self.noise_floor + 0.0001 * abs_err;
            error
        }
    }

    pub fn process_frame(&mut self, mic_frame: &[f32], ref_frame: &[f32], out_frame: &mut [f32]) {
        let len = mic_frame.len().min(out_frame.len());
        for i in 0..len {
            let ref_s = if i < ref_frame.len() { ref_frame[i] } else { 0.0 };
            out_frame[i] = self.process_sample(mic_frame[i], ref_s);
        }
    }
}
