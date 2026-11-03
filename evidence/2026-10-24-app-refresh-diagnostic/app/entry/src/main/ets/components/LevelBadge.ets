/**
 * 预警等级徽标（胶囊）。level 使用字符串，避免依赖旧 Mock 模型。
 */
import { Color, FontSize, FontWeight_, Radius, Space } from '../common/Theme';

function levelLabel(level: string): string {
  if (level === 'critical') return '紧急';
  if (level === 'high') return '高危';
  if (level === 'medium') return '中等';
  return '提示';
}

function levelColor(level: string): string {
  if (level === 'critical') return '#EF4444';
  if (level === 'high') return '#F59E0B';
  if (level === 'medium') return '#0EA5E9';
  return '#64748B';
}

function levelBg(level: string): string {
  if (level === 'critical') return '#FEE2E2';
  if (level === 'high') return '#FEF3C7';
  if (level === 'medium') return '#E0F2FE';
  return '#F1F5F9';
}

@Component
export struct LevelBadge {
  @Prop level: string = 'low';
  @Prop small: boolean = false;

  build() {
    Row() {
      Column()
        .width(this.small ? 6 : 8)
        .height(this.small ? 6 : 8)
        .borderRadius(this.small ? 3 : 4)
        .backgroundColor(levelColor(this.level))
        .margin({ right: Space.xs + 2 })
      Text(levelLabel(this.level))
        .fontSize(this.small ? FontSize.mini : FontSize.caption)
        .fontWeight(FontWeight_.semibold)
        .fontColor(levelColor(this.level))
    }
    .padding({
      left: this.small ? Space.sm : Space.md,
      right: this.small ? Space.sm : Space.md,
      top: this.small ? 2 : Space.xs,
      bottom: this.small ? 2 : Space.xs
    })
    .backgroundColor(levelBg(this.level))
    .borderRadius(Radius.pill)
  }
}

/**
 * 通用胶囊 Tag
 */
@Component
export struct TagChip {
  @Prop text: string = '';
  @Prop color: string = Color.textSecondary;
  @Prop bg: string = '#F1F5F9';

  build() {
    Text(this.text)
      .fontSize(FontSize.caption)
      .fontColor(this.color)
      .padding({ left: Space.sm, right: Space.sm, top: 3, bottom: 3 })
      .backgroundColor(this.bg)
      .borderRadius(Radius.pill)
  }
}
