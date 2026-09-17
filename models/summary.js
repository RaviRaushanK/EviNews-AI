module.exports = (sequelize, DataTypes) => {
  const Summary = sequelize.define('Summary', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the summary'
    },
    event_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to events.id'
    },
    summary_text: {
      type: DataTypes.TEXT('long'),
      allowNull: false,
      comment: 'The generated AI summary'
    },
    model_provider: {
      type: DataTypes.ENUM('gemini', 'openai', 'local'),
      allowNull: false,
      defaultValue: 'gemini',
      comment: 'AI model provider used'
    },
    model_version: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Version of the model used'
    },
    generated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'When the summary was generated'
    },
    verification_status: {
      type: DataTypes.ENUM('pending', 'verified', 'needs_review'),
      allowNull: false,
      defaultValue: 'pending',
      comment: 'Verification status of the summary'
    }
  }, {
    tableName: 'summaries',
    timestamps: true,
    underscored: false,
    comment: 'AI-generated event summaries',
    indexes: [
      {
        name: 'idx_summaries_event_id',
        fields: ['event_id']
      },
      {
        name: 'idx_summaries_generated_at',
        fields: ['generated_at']
      },
      {
        name: 'idx_summaries_model_provider',
        fields: ['model_provider']
      },
      {
        name: 'idx_summaries_verification_status',
        fields: ['verification_status']
      }
    ]
  });

  Summary.associate = (models) => {
    Summary.belongsTo(models.Event, {
      foreignKey: 'event_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Summary.belongsToMany(models.Claim, {
      through: models.SummaryClaim,
      foreignKey: 'summary_id',
      otherKey: 'claim_id'
    });
  };

  return Summary;
};