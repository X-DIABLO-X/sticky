use rtrb::{Consumer, Producer, RingBuffer};

pub struct AudioRingProducer {
    producer: Producer<f32>,
}

pub struct AudioRingConsumer {
    consumer: Consumer<f32>,
}

pub fn create_audio_ring_buffer(capacity: usize) -> (AudioRingProducer, AudioRingConsumer) {
    let (producer, consumer) = RingBuffer::new(capacity);
    (
        AudioRingProducer { producer },
        AudioRingConsumer { consumer },
    )
}

impl AudioRingProducer {
    pub fn push(&mut self, sample: f32) -> bool {
        self.producer.push(sample).is_ok()
    }

    pub fn push_slice(&mut self, slice: &[f32]) -> usize {
        let mut written = 0;
        for &sample in slice {
            if self.producer.push(sample).is_ok() {
                written += 1;
            } else {
                break;
            }
        }
        written
    }

    pub fn slots_free(&self) -> usize {
        self.producer.slots()
    }
}

impl AudioRingConsumer {
    pub fn pop(&mut self) -> Option<f32> {
        self.consumer.pop().ok()
    }

    pub fn pop_slice(&mut self, out: &mut [f32]) -> usize {
        let mut read = 0;
        for item in out.iter_mut() {
            if let Ok(sample) = self.consumer.pop() {
                *item = sample;
                read += 1;
            } else {
                break;
            }
        }
        read
    }

    pub fn slots_available(&self) -> usize {
        self.consumer.slots()
    }

    pub fn flush(&mut self) {
        while self.consumer.pop().is_ok() {}
    }
}
