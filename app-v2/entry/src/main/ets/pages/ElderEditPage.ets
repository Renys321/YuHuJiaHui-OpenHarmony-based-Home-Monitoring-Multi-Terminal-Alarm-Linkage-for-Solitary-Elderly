/**
 * 守护对象资料编辑页（独立于 AI 健康评估）
 * 姓名/年龄/性别/住址/病史 → 本机 Preferences + AppStorage，供首页/我的展示。
 */
import { Color, FontSize, FontWeight_, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { ElderProfileLocal } from '../common/ElderProfileLocal';
import { MockData } from '../common/MockData';
import { Elder } from '../model/Elder';

@Entry
@Component
struct ElderEditPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State name: string = '';
  @State ageText: string = '';
  @State heightText: string = '';
  @State weightText: string = '';
  @State medications: string = '';
  @State systolicText: string = '';
  @State diastolicText: string = '';
  @State glucoseText: string = '';
  @State gender: string = 'male';
  @State address: string = '';
  @State history: string = '';
  @State saving: boolean = false;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  aboutToAppear(): void {
    const ctx = this.getUIContext().getHostContext();
    const seed: Elder = MockData.elder();
    this.name = seed.name;
    this.ageText = seed.age > 0 ? `${seed.age}` : '';
    this.heightText = seed.heightCm > 0 ? `${seed.heightCm}` : '';
    this.weightText = seed.weightKg > 0 ? `${seed.weightKg}` : '';
    this.medications = seed.medications;
    this.systolicText = seed.systolic > 0 ? `${seed.systolic}` : '';
    this.diastolicText = seed.diastolic > 0 ? `${seed.diastolic}` : '';
    this.glucoseText = seed.fastingGlucose > 0 ? `${seed.fastingGlucose}` : '';
    this.gender = seed.gender;
    this.address = seed.address;
    this.history = seed.medicalHistory;
    if (ctx !== undefined) {
      ElderProfileLocal.load(ctx).then((e: Elder | null) => {
        if (e !== null) {
          this.name = e.name;
          this.ageText = e.age > 0 ? `${e.age}` : '';
          this.heightText = e.heightCm > 0 ? `${e.heightCm}` : '';
          this.weightText = e.weightKg > 0 ? `${e.weightKg}` : '';
          this.medications = e.medications;
          this.systolicText = e.systolic > 0 ? `${e.systolic}` : '';
          this.diastolicText = e.diastolic > 0 ? `${e.diastolic}` : '';
          this.glucoseText = e.fastingGlucose > 0 ? `${e.fastingGlucose}` : '';
          this.gender = e.gender;
          this.address = e.address;
          this.history = e.medicalHistory;
        }
      });
    }
  }

  private parseNum(text: string): number {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private save(): void {
    if (this.saving) return;
    const n = this.name.trim();
    if (n.length === 0) {
      this.getUIContext().getPromptAction().showToast({ message: '请填写守护对象姓名' });
      return;
    }
    const age = Number.parseInt(this.ageText.length > 0 ? this.ageText : '0', 10);
    if (Number.isNaN(age) || age < 0 || age > 130) {
      this.getUIContext().getPromptAction().showToast({ message: '年龄需为 0–130 的整数' });
      return;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) return;
    const e = new Elder();
    e.id = 'LOCAL';
    e.name = n;
    e.age = age;
    e.gender = this.gender === 'female' ? 'female' : 'male';
    e.address = this.address.trim();
    e.medicalHistory = this.history.trim();
    e.heightCm = this.parseNum(this.heightText);
    e.weightKg = this.parseNum(this.weightText);
    e.medications = this.medications.trim();
    e.systolic = this.parseNum(this.systolicText);
    e.diastolic = this.parseNum(this.diastolicText);
    e.fastingGlucose = this.parseNum(this.glucoseText);
    this.saving = true;
    AppStorage.setOrCreate<Elder>('gv.elderOverride', e);
    AppStorage.setOrCreate<number>('gv.elderRevision', Date.now());
    ElderProfileLocal.save(ctx, e).then(() => {
      this.saving = false;
      this.getUIContext().getPromptAction().showToast({ message: '已保存守护对象资料' });
      this.getUIContext().getRouter().back();
    }).catch(() => {
      this.saving = false;
      this.getUIContext().getPromptAction().showToast({ message: '保存失败，请重试' });
    });
  }

  @Builder
  fieldBlock(label: string, hint: string, value: string, onChange: (v: string) => void,
             inputType: InputType = InputType.Normal, maxLen: number = 100) {
    Column() {
      Text(label)
        .fontSize(FontSize.caption)
        .fontWeight(FontWeight_.semibold)
        .fontColor(Color.textSecondary)
        .width('100%')
      TextInput({ placeholder: hint, text: value })
        .type(inputType)
        .maxLength(maxLen)
        .fontSize(FontSize.body)
        .fontColor(Color.textPrimary)
        .backgroundColor('#F8FAFC')
        .borderRadius(Radius.button)
        .border({ width: 1, color: Color.border })
        .padding({ left: Space.md, right: Space.md })
        .height(48)
        .width('100%')
        .margin({ top: 6 })
        .onChange(onChange)
    }
    .width('100%')
    .margin({ bottom: Space.md })
  }

  build() {
    Column() {
      NavBar({ title: '守护对象资料', showBack: true, rightText: '保存',
        onRight: () => { this.save(); } })
      Scroll() {
        Column() {
          Column() {
            Text('这些资料只用于本机展示与健康评估回填；姓名/住址/性别不会上传到健康接口。')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .lineHeight(17)
              .width('100%')
          }
          .width('100%')
          .padding(Space.md)
          .backgroundColor('#EFF6FF')
          .borderRadius(Radius.chip)
          .margin({ bottom: Space.md })

          Column() {
            this.fieldBlock('姓名', '请输入姓名', this.name, (v: string) => { this.name = v; }, InputType.Normal, 20)

            Column() {
              Text('性别')
                .fontSize(FontSize.caption)
                .fontWeight(FontWeight_.semibold)
                .fontColor(Color.textSecondary)
                .width('100%')
              Row({ space: 8 }) {
                Text('男')
                  .fontSize(FontSize.body)
                  .fontWeight(this.gender === 'male' ? FontWeight_.bold : FontWeight_.regular)
                  .fontColor(this.gender === 'male' ? Color.primaryDark : Color.textSecondary)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Center)
                  .padding({ top: 10, bottom: 10 })
                  .backgroundColor(this.gender === 'male' ? '#E0F2FE' : '#F8FAFC')
                  .borderRadius(Radius.button)
                  .onClick(() => { this.gender = 'male'; })
                Text('女')
                  .fontSize(FontSize.body)
                  .fontWeight(this.gender === 'female' ? FontWeight_.bold : FontWeight_.regular)
                  .fontColor(this.gender === 'female' ? Color.primaryDark : Color.textSecondary)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Center)
                  .padding({ top: 10, bottom: 10 })
                  .backgroundColor(this.gender === 'female' ? '#E0F2FE' : '#F8FAFC')
                  .borderRadius(Radius.button)
                  .onClick(() => { this.gender = 'female'; })
              }
              .width('100%')
              .margin({ top: 6 })
            }
            .width('100%')
            .margin({ bottom: Space.md })

            this.fieldBlock('年龄', '例如 72', this.ageText, (v: string) => { this.ageText = v; }, InputType.Number, 3)
            this.fieldBlock('身高(cm)', '例如 165', this.heightText, (v: string) => { this.heightText = v; }, InputType.Number, 3)
            this.fieldBlock('体重(kg)', '例如 62', this.weightText, (v: string) => { this.weightText = v; }, InputType.Number, 4)
            this.fieldBlock('长期用药', '例如 氨氯地平（只记药名）', this.medications, (v: string) => { this.medications = v; }, InputType.Normal, 200)
            this.fieldBlock('收缩压', '例如 135', this.systolicText, (v: string) => { this.systolicText = v; }, InputType.Number, 3)
            this.fieldBlock('舒张压', '例如 85', this.diastolicText, (v: string) => { this.diastolicText = v; }, InputType.Number, 3)
            this.fieldBlock('空腹血糖', '例如 5.6', this.glucoseText, (v: string) => { this.glucoseText = v; }, InputType.Number, 4)
            this.fieldBlock('住址', '例如 郑州市金水区…', this.address, (v: string) => { this.address = v; }, InputType.Normal, 100)
            this.fieldBlock('既往病史', '例如 高血压（长期服药控制）', this.history, (v: string) => { this.history = v; }, InputType.Normal, 300)

            Button(this.saving ? '保存中…' : '保存资料')
              .width('100%')
              .height(48)
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor('#FFFFFF')
              .backgroundColor(Color.primary)
              .borderRadius(Radius.button)
              .enabled(!this.saving)
              .onClick(() => { this.save(); })
          }
          .width('100%')
          .padding(Space.lg - 2)
          .backgroundColor(Color.card)
          .borderRadius(Radius.card)
          .shadow(Shadow_.card())
        }
        .width('100%')
        .padding({ left: this.pm(), right: this.pm(), top: Space.md, bottom: Space.xxl })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
