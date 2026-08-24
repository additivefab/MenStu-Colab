export type MeetingInterval = { startsAt: number; endsAt: number };

export function shanghaiMeetingInterval(date: string, time: string, durationMinutes: number): MeetingInterval {
  const startsAt = Date.parse(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(startsAt) || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new Error("会议时间无效");
  }
  return { startsAt, endsAt: startsAt + durationMinutes * 60_000 };
}

export function meetingIntervalsOverlap(left: MeetingInterval, right: MeetingInterval) {
  return left.startsAt < right.endsAt && right.startsAt < left.endsAt;
}
