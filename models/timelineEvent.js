module.exports = (sequelize, DataTypes) => {
  const TimelineEvent = sequelize.define('TimelineEvent', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the timeline event'
    },
    event_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to events.id'
    },
    claim_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Foreign key to claims.id (nullable)'
    },
    article_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Foreign key to articles.id (nullable)'
    },
    timeline_date: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Date/time of the timeline event'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Description of what happened at this timeline point'
    }
  }, {
    tableName: 'timeline_events',
    timestamps: true,
    underscored: false,
    comment: 'Chronological timeline of events',
    indexes: [
      {
        name: 'idx_timeline_events_event_id',
        fields: ['event_id']
      },
      {
        name: 'idx_timeline_events_timeline_date',
        fields: ['timeline_date']
      },
      {
        name: 'idx_timeline_events_claim_id',
        fields: ['claim_id']
      },
      {
        name: 'idx_timeline_events_article_id',
        fields: ['article_id']
      },
      {
        name: 'idx_timeline_events_event_date',
        fields: ['event_id', { attribute: 'timeline_date', order: 'ASC' }]
      }
    ]
  });

  TimelineEvent.associate = (models) => {
    TimelineEvent.belongsTo(models.Event, {
      foreignKey: 'event_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    TimelineEvent.belongsTo(models.Claim, {
      foreignKey: 'claim_id',
      onDelete: 'SET NULL',
      hooks: true
    });
    TimelineEvent.belongsTo(models.Article, {
      foreignKey: 'article_id',
      onDelete: 'SET NULL',
      hooks: true
    });
  };

  return TimelineEvent;
};