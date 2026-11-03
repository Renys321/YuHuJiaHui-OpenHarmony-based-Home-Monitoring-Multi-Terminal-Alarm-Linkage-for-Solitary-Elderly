/**
 * 老人档案模型
 */
@Observed
export class Elder {
  id: string = '';
  name: string = '';
  age: number = 0;
  gender: 'male' | 'female' = 'male';
  avatar: string = '';
  address: string = '';
  phone: string = '';
  medicalHistory: string = '';
  heightCm: number = 0;
  weightKg: number = 0;
  medications: string = '';
  systolic: number = 0;
  diastolic: number = 0;
  fastingGlucose: number = 0;
  emergencyContacts: EmergencyContact[] = [];
  communityGrid: string = '';   // 社区网格员
  communityPhone: string = '';
}

@Observed
export class EmergencyContact {
  id: string = '';
  name: string = '';
  relation: string = '';        // 儿子 / 女儿 / 邻居 / 社区
  phone: string = '';
  priority: number = 1;         // 呼叫顺序
  notifyEnabled: boolean = true;
}
